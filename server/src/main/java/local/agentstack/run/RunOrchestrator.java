package local.agentstack.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import local.agentstack.config.AppProperties;
import local.agentstack.domain.Message;
import local.agentstack.domain.Run;
import local.agentstack.domain.RunEvent;
import local.agentstack.domain.Timestamps;
import local.agentstack.protocol.EventType;
import local.agentstack.protocol.ProtocolEvent;
import local.agentstack.repo.MessageRepository;
import local.agentstack.repo.RunEventRepository;
import local.agentstack.repo.RunRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 一次 run 的编排：消费 runtime 的 NDJSON 事件流，分配 seq，落库，再推给 SSE 订阅者。
 *
 * 三条不变量（都有测试覆盖）：
 *  1) seq 只由本类分配，单调递增，与落库顺序一致 —— 浏览器靠它判重与续传。
 *  2) 先落库再 publish —— 任何"客户端看到的事件"都一定已经在库里。
 *  3) 无论成功、失败、超时还是 runtime 连不上，run 一定被写成终态并收到终态事件。
 */
@Service
public class RunOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(RunOrchestrator.class);

    private final RuntimeClient runtime;
    private final RunRepository runRepo;
    private final RunEventRepository eventRepo;
    private final MessageRepository messageRepo;
    private final RunEventBroadcaster broadcaster;
    private final ObjectMapper mapper;
    private final AppProperties props;

    public RunOrchestrator(RuntimeClient runtime, RunRepository runRepo, RunEventRepository eventRepo,
                           MessageRepository messageRepo, RunEventBroadcaster broadcaster,
                           ObjectMapper mapper, AppProperties props) {
        this.runtime = runtime;
        this.runRepo = runRepo;
        this.eventRepo = eventRepo;
        this.messageRepo = messageRepo;
        this.broadcaster = broadcaster;
        this.mapper = mapper;
        this.props = props;
    }

    /** 在虚拟线程上异步执行，立即返回给 HTTP 线程（202 Accepted）。 */
    public void start(Run run, JsonNode graph, int graphSchemaVersion, Map<String, Object> input,
                      List<RuntimeClient.HistoryMessage> history) {
        Thread.ofVirtual().name("run-" + run.getId()).start(() -> {
            try {
                execute(run, graph, graphSchemaVersion, input, history);
            } catch (Throwable t) {
                log.error("run {} 编排线程异常退出", run.getId(), t);
            }
        });
    }

    private void execute(Run run, JsonNode graph, int graphSchemaVersion, Map<String, Object> input,
                         List<RuntimeClient.HistoryMessage> history) {
        String runId = run.getId();
        RunEventChannel channel = broadcaster.channel(runId);
        long startedAt = System.currentTimeMillis();
        int seq = 0;
        boolean terminal = false;
        boolean errorEmitted = false;
        JsonNode errorPayload = null;

        try {
            run.markRunning();
            runRepo.save(run);

            RuntimeClient.ExecuteRequest request = new RuntimeClient.ExecuteRequest(
                    runId, run.getConversationId(), graph, graphSchemaVersion, input, history);

            try (Stream<String> lines = runtime.execute(request)) {
                Iterator<String> it = lines.iterator();
                while (it.hasNext()) {
                    String line = it.next();
                    if (line == null || line.isBlank()) {
                        continue;
                    }
                    if (System.currentTimeMillis() - startedAt > props.runtime().executeTimeoutMs()) {
                        errorPayload = errorNode("TIMEOUT",
                                "运行超过 " + props.runtime().executeTimeoutMs() + "ms 上限", true);
                        break;
                    }

                    JsonNode raw;
                    try {
                        raw = mapper.readTree(line);
                    } catch (JsonProcessingException e) {
                        log.warn("run {} 收到无法解析的 NDJSON 行，已跳过: {}", runId, abbreviate(line));
                        continue;
                    }

                    String type = raw.path("type").asText("");
                    if (!EventType.isKnown(type)) {
                        log.warn("run {} 收到未知事件类型，已跳过: {}", runId, type);
                        continue;
                    }
                    JsonNode nodeIdNode = raw.path("nodeId");
                    String nodeId = nodeIdNode.isMissingNode() || nodeIdNode.isNull() ? null : nodeIdNode.asText();
                    JsonNode payload = raw.path("payload");
                    if (payload.isMissingNode()) {
                        payload = mapper.createObjectNode();
                    }

                    seq = emit(channel, run, seq, type, nodeId, payload, Timestamps.now());

                    if (EventType.MESSAGE_COMPLETED.wire().equals(type)) {
                        persistMessage(run, payload);
                    } else if (EventType.RUN_ERROR.wire().equals(type)) {
                        errorPayload = payload;
                        errorEmitted = true;
                    } else if (EventType.RUN_FINISHED.wire().equals(type)) {
                        terminal = true;
                        String status = payload.path("status").asText("SUCCEEDED");
                        String answer = textOrNull(payload, "answer");
                        finishRun(run, status, answer, "SUCCEEDED".equals(status) ? null : errorPayload);
                        break;
                    }
                }
            }
        } catch (RuntimeClient.RuntimeCallException e) {
            log.warn("run {} 调用 runtime 失败: {}", runId, e.getMessage());
            errorPayload = errorNode("RUNTIME_UNAVAILABLE", e.getMessage(), true);
        } catch (Exception e) {
            log.error("run {} 执行失败", runId, e);
            errorPayload = errorNode("INTERNAL", "服务端异常: " + e.getMessage(), false);
        } finally {
            try {
                if (!terminal) {
                    if (errorPayload == null) {
                        errorPayload = errorNode("INTERNAL", "运行未产出终止事件（连接提前中断）", true);
                    }
                    if (!errorEmitted) {
                        seq = emit(channel, run, seq, EventType.RUN_ERROR.wire(), null, errorPayload, Timestamps.now());
                    }
                    seq = emit(channel, run, seq, EventType.RUN_FINISHED.wire(), null,
                            finishedNode("FAILED", System.currentTimeMillis() - startedAt, null), Timestamps.now());
                    finishRun(run, "FAILED", null, errorPayload);
                }
            } catch (Exception e) {
                log.error("run {} 写入终态失败", runId, e);
            } finally {
                channel.complete();
            }
        }
    }

    /** 分配 seq → 落库 → 再 publish。顺序不可颠倒。 */
    private int emit(RunEventChannel channel, Run run, int seq, String type, String nodeId,
                     JsonNode payload, Instant ts) {
        int next = seq + 1;
        JsonNode safe = payload == null || payload.isMissingNode() ? mapper.createObjectNode() : payload;
        try {
            eventRepo.save(new RunEvent(run.getId(), next, type, nodeId,
                    mapper.writeValueAsString(safe), ts));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("事件 payload 无法序列化", e);
        }
        channel.publish(new ProtocolEvent(next, type, run.getId(), nodeId, safe, ts));
        return next;
    }

    private void persistMessage(Run run, JsonNode payload) {
        String role = payload.path("role").asText("assistant");
        String content = textOrNull(payload, "content");
        JsonNode toolCalls = payload.get("toolCalls");
        String toolCallsJson = toolCalls == null || toolCalls.isNull() ? null : toolCalls.toString();
        int nextSeq = messageRepo.findMaxSeq(run.getConversationId()) + 1;
        messageRepo.save(new Message(UUID.randomUUID().toString(), run.getConversationId(), run.getId(),
                nextSeq, role, content, toolCallsJson, Timestamps.now()));
    }

    private void finishRun(Run run, String status, String answer, JsonNode error) {
        Instant now = Timestamps.now();
        if ("SUCCEEDED".equals(status)) {
            run.markSucceeded(answer, now);
        } else {
            run.markFailed(error == null ? null : error.toString(), now);
        }
        runRepo.save(run);
    }

    private JsonNode errorNode(String code, String message, boolean retryable) {
        ObjectNode node = mapper.createObjectNode();
        node.put("code", code);
        node.put("message", message);
        node.put("retryable", retryable);
        return node;
    }

    private JsonNode finishedNode(String status, long durationMs, String answer) {
        ObjectNode node = mapper.createObjectNode();
        node.put("status", status);
        node.put("durationMs", durationMs);
        if (answer == null) {
            node.putNull("answer");
        } else {
            node.put("answer", answer);
        }
        return node;
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private static String abbreviate(String s) {
        return s.length() <= 200 ? s : s.substring(0, 200) + "...";
    }
}
