package local.agentstack.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import local.agentstack.domain.Run;
import local.agentstack.domain.Timestamps;
import local.agentstack.domain.TraceSpan;
import local.agentstack.repo.TraceSpanRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 把事件流投影成【持久化】的调用轨迹。
 *
 * 为什么放在 server 而不是 runtime：轨迹要能按 agent / 会话 / 时间检索，
 * 而这三者都只存在于 server 的数据库里；"runtime 无状态、不碰库"这条边界不能破。
 *
 * 语义：
 *  - node.started/finished → 一条 node span（画布节点）
 *  - llm.completed         → 一条 model span，含模型输入与输出
 *  - tool.started/finished → 一条 tool / mcp / skill span，含参数与结果
 *  - node.log              → 一条 log span，并把它的输入/输出补到仍开着的节点 span 上
 *  - 其余事件不进轨迹：token 流太多，其价值已被 model span 的输入输出覆盖
 *
 * 每条 span 在**结束时**写入（那时才有耗时与结果），但 span_seq 在开始时就分配，
 * 所以顺序仍然反映真实发生顺序。写入失败只告警：轨迹是旁路，绝不影响运行本身。
 */
@Component
public class TraceRecorder {

    private static final Logger log = LoggerFactory.getLogger(TraceRecorder.class);

    /** 单条 span 的输入/输出落库上限。够事后复盘，又不至于把库撑爆。 */
    private static final int MAX_TEXT = 8000;

    private final TraceSpanRepository repo;
    private final ObjectMapper mapper;
    private final Map<String, RunTrace> traces = new ConcurrentHashMap<>();

    public TraceRecorder(TraceSpanRepository repo, ObjectMapper mapper) {
        this.repo = repo;
        this.mapper = mapper;
    }

    /** 每个事件落库之后调用（挂在 RunOrchestrator.emit 里）。 */
    public void record(Run run, String type, String nodeId, JsonNode payload, Instant ts) {
        try {
            RunTrace trace = traces.computeIfAbsent(run.getId(),
                    id -> new RunTrace(run.getId(), run.getConversationId(), run.getAgentId()));
            JsonNode safe = payload == null ? mapper.createObjectNode() : payload;

            switch (type) {
                case "node.started" -> trace.open(nodeKey(nodeId), "node",
                        text(safe, "nodeType", "node"), nodeId, null, null, ts);
                case "node.finished" -> close(trace, nodeKey(nodeId),
                        "ok".equals(text(safe, "status", "ok")) ? "ok" : "error",
                        null, durationOf(safe), "node", ts);
                case "llm.completed" -> write(trace, "model", text(safe, "model", "model"), nodeId,
                        wrapText("text", text(safe, "input", null)),
                        wrapText("text", text(safe, "output", null)),
                        modelAttributes(safe), "ok", null, ts, ts, durationOf(safe));
                case "tool.started" -> trace.open(toolKey(safe), text(safe, "kind", "tool"),
                        text(safe, "toolName", "tool"), nodeId, jsonNode(safe.get("args")), null, ts);
                case "tool.finished" -> close(trace, toolKey(safe),
                        safe.path("isError").asBoolean(false) ? "error" : "ok",
                        wrapText("result", text(safe, "result", null)), durationOf(safe),
                        text(safe, "kind", "tool"), ts);
                case "node.log" -> recordNodeLog(trace, nodeId, safe, ts);
                default -> {
                    // 其余事件不进轨迹
                }
            }
        } catch (Exception e) {
            log.warn("run {} 写入轨迹失败: {}", run.getId(), e.getMessage());
        }
    }

    /** run 收尾：把还开着的 span 落库，避免留下"永远没有结束"的记录。 */
    public void finish(Run run, String runStatus) {
        RunTrace trace = traces.remove(run.getId());
        if (trace == null) {
            return;
        }
        String spanStatus = switch (runStatus) {
            case "SUCCEEDED" -> "ok";
            case "CANCELLED" -> "cancelled";
            default -> "error";
        };
        Instant now = Timestamps.now();
        for (OpenSpan span : trace.drainOpen()) {
            try {
                write(trace, span.kind(), span.name(), span.nodeId(), span.inputJson(), span.outputJson(),
                        span.attributesJson(), spanStatus,
                        "ok".equals(spanStatus) ? null : "运行在结束前中断",
                        span.startedAt(), now,
                        (int) Math.max(0, now.toEpochMilli() - span.startedAt().toEpochMilli()));
            } catch (Exception e) {
                log.warn("run {} 收尾轨迹失败: {}", run.getId(), e.getMessage());
            }
        }
    }

    private void close(RunTrace trace, String key, String status, String outputJson,
                       Integer durationMs, String kindFallback, Instant endedAt) {
        OpenSpan span = trace.take(key);
        if (span == null) {
            // 没看到 started（事件被截断/丢包）也要留痕，否则轨迹里会莫名缺一段
            span = new OpenSpan(trace.nextSeq(), kindFallback == null ? "tool" : kindFallback,
                    kindFallback == null ? "unknown" : kindFallback, null, null, null, endedAt, null);
        }
        String resolvedOutput = outputJson != null ? outputJson : span.outputJson();
        write(trace, span.kind(), span.name(), span.nodeId(), span.inputJson(), resolvedOutput,
                span.attributesJson(), status,
                "error".equals(status) ? "调用返回错误" : null,
                span.startedAt(), endedAt, durationMs);
    }

    /** 节点过程日志：单独落一条，同时把输入/输出补到还没关闭的节点 span 上。 */
    private void recordNodeLog(RunTrace trace, String nodeId, JsonNode payload, Instant ts) {
        String message = text(payload, "message", "log");
        String level = text(payload, "level", "info");
        ObjectNode attrs = mapper.createObjectNode();
        attrs.put("level", level);
        attrs.put("nodeType", text(payload, "nodeType", "node"));
        String inputJson = jsonNode(payload.get("input"));
        String outputJson = jsonNode(payload.get("output"));
        trace.noteIo(nodeKey(nodeId), inputJson, outputJson);
        write(trace, "log", message, nodeId, inputJson, outputJson, attrs.toString(),
                "error".equals(level) ? "error" : "ok",
                "error".equals(level) ? message : null,
                ts, ts, null);
    }

    private void write(RunTrace trace, String kind, String name, String nodeId,
                       String inputJson, String outputJson, String attributesJson,
                       String status, String errorText, Instant startedAt, Instant endedAt, Integer durationMs) {
        TraceSpan span = new TraceSpan(UUID.randomUUID().toString(), trace.runId(), trace.conversationId(),
                trace.agentId(), trace.nextSeq(), kind, truncate(name, 160), nodeId, status,
                startedAt, endedAt == null ? startedAt : endedAt, durationMs,
                truncate(inputJson, MAX_TEXT), truncate(outputJson, MAX_TEXT),
                truncate(attributesJson, MAX_TEXT), truncate(errorText, 1024), Timestamps.now());
        repo.save(span);
    }

    // ---------------------------------------------------------------- 小工具

    private static String nodeKey(String nodeId) {
        return nodeId == null ? null : "n:" + nodeId;
    }

    private static String toolKey(JsonNode payload) {
        String callId = text(payload, "callId", null);
        return callId == null ? null : "t:" + callId;
    }

    private static Integer durationOf(JsonNode payload) {
        JsonNode value = payload.get("durationMs");
        return value != null && value.isNumber() ? value.asInt() : null;
    }

    private String modelAttributes(JsonNode payload) {
        ObjectNode attrs = mapper.createObjectNode();
        for (String field : new String[] {"inputTokens", "outputTokens", "messageCount", "finishReason",
                "estimated", "durationMs", "inputTruncated", "outputTruncated"}) {
            JsonNode value = payload.get(field);
            if (value != null && !value.isNull()) {
                attrs.set(field, value);
            }
        }
        return attrs.isEmpty() ? null : attrs.toString();
    }

    private String wrapText(String key, String value) {
        if (value == null) {
            return null;
        }
        ObjectNode node = mapper.createObjectNode();
        node.put(key, truncate(value, MAX_TEXT));
        return node.toString();
    }

    private static String jsonNode(JsonNode value) {
        return value == null || value.isNull() ? null : value.toString();
    }

    private static String text(JsonNode payload, String field, String fallback) {
        JsonNode value = payload == null ? null : payload.get(field);
        if (value == null || value.isNull() || value.asText().isBlank()) {
            return fallback;
        }
        return value.asText();
    }

    private static String truncate(String text, int max) {
        if (text == null) {
            return null;
        }
        return text.length() <= max ? text : text.substring(0, max) + "…[已截断]";
    }

    /** 一次 run 的轨迹状态：只负责序号与未结束的 span，落库由 TraceRecorder 做。 */
    private static final class RunTrace {
        private final String runId;
        private final String conversationId;
        private final String agentId;
        private final AtomicInteger seq = new AtomicInteger();
        private final Map<String, OpenSpan> open = new ConcurrentHashMap<>();

        RunTrace(String runId, String conversationId, String agentId) {
            this.runId = runId;
            this.conversationId = conversationId;
            this.agentId = agentId;
        }

        String runId() {
            return runId;
        }

        String conversationId() {
            return conversationId;
        }

        String agentId() {
            return agentId;
        }

        int nextSeq() {
            return seq.incrementAndGet();
        }

        void open(String key, String kind, String name, String nodeId,
                  String inputJson, String attributesJson, Instant startedAt) {
            if (key == null) {
                return;
            }
            open.put(key, new OpenSpan(nextSeq(), kind, name, nodeId, inputJson, attributesJson, startedAt, null));
        }

        /** 把节点过程日志里的输入/输出补到仍开着的节点 span。输入只记第一次，输出记最新一次。 */
        void noteIo(String key, String inputJson, String outputJson) {
            if (key == null) {
                return;
            }
            OpenSpan span = open.get(key);
            if (span == null) {
                return;
            }
            open.put(key, new OpenSpan(span.seq(), span.kind(), span.name(), span.nodeId(),
                    span.inputJson() != null ? span.inputJson() : inputJson,
                    span.attributesJson(), span.startedAt(),
                    outputJson != null ? outputJson : span.outputJson()));
        }

        OpenSpan take(String key) {
            return key == null ? null : open.remove(key);
        }

        List<OpenSpan> drainOpen() {
            List<OpenSpan> remaining = new ArrayList<>(open.values());
            open.clear();
            return remaining;
        }
    }

    private record OpenSpan(int seq, String kind, String name, String nodeId,
                            String inputJson, String attributesJson, Instant startedAt, String outputJson) {
    }
}
