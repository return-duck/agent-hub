package local.agentstack.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.api.dto.TraceDtos;
import local.agentstack.domain.Agent;
import local.agentstack.domain.Conversation;
import local.agentstack.domain.Message;
import local.agentstack.domain.Run;
import local.agentstack.repo.ConversationRepository;
import local.agentstack.repo.MessageRepository;
import local.agentstack.repo.RunRepository;
import local.agentstack.repo.TraceSpanRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 调用轨迹的读取。写入在 TraceRecorder（随事件流投影），这里只管查询。 */
@Service
public class TraceService {

    private final TraceSpanRepository spanRepo;
    private final RunRepository runRepo;
    private final MessageRepository messageRepo;
    private final ConversationRepository conversationRepo;
    private final ObjectMapper mapper;

    public TraceService(TraceSpanRepository spanRepo, RunRepository runRepo, MessageRepository messageRepo,
                        ConversationRepository conversationRepo, ObjectMapper mapper) {
        this.spanRepo = spanRepo;
        this.runRepo = runRepo;
        this.messageRepo = messageRepo;
        this.conversationRepo = conversationRepo;
        this.mapper = mapper;
    }

    /**
     * 一个会话的完整轨迹：把该会话下**每一轮**的 span 按 run 分组，按时间正序返回。
     *
     * 放在服务端分组而不是让前端拉两份数据自己拼：轮次信息分散在 run（状态/耗时）、
     * message（这一轮问了什么、答了什么）和 trace_span（执行细节）三张表里，
     * 拼装逻辑只该有一份。前端拿到的就是"可以直接渲染的一页"。
     */
    @Transactional(readOnly = true)
    public TraceDtos.ConversationTrace conversationTrace(String conversationId) {
        List<Run> runs = runRepo.findByConversationIdOrderByStartedAtDesc(conversationId).stream()
                .sorted((a, b) -> a.getStartedAt().compareTo(b.getStartedAt()))
                .toList();
        List<Message> messages = messageRepo.findByConversationIdOrderBySeqAsc(conversationId);

        Map<String, List<TraceDtos.Span>> spansByRun = new LinkedHashMap<>();
        for (local.agentstack.domain.TraceSpan span : spanRepo
                .findByConversationIdOrderByStartedAtAscSpanSeqAsc(conversationId)) {
            spansByRun.computeIfAbsent(span.getRunId(), key -> new ArrayList<>()).add(toSpan(span));
        }

        Map<String, String> questionByRun = new LinkedHashMap<>();
        Map<String, String> answerByRun = new LinkedHashMap<>();
        for (Message message : messages) {
            if (message.getRunId() == null) {
                continue;
            }
            String content = message.getContent() == null ? "" : message.getContent();
            if ("user".equals(message.getRole())) {
                questionByRun.put(message.getRunId(), content);
            } else if ("assistant".equals(message.getRole()) && !content.isBlank()) {
                answerByRun.put(message.getRunId(), content);
            }
        }

        List<TraceDtos.Turn> turns = new ArrayList<>();
        for (Run run : runs) {
            turns.add(new TraceDtos.Turn(run.getId(), run.getStatus().name(),
                    run.getStartedAt(), run.getFinishedAt(), durationOf(run),
                    preview(questionByRun.get(run.getId()), 200),
                    preview(answerByRun.get(run.getId()), 200),
                    run.getErrorJson() == null ? null : preview(run.getErrorJson(), 200),
                    spansByRun.getOrDefault(run.getId(), List.of())));
        }

        // 没有 run 记录但有 span（理论上不该出现）时也要能显示，避免"有轨迹却看不到"
        for (Map.Entry<String, List<TraceDtos.Span>> entry : spansByRun.entrySet()) {
            boolean known = turns.stream().anyMatch(t -> t.runId().equals(entry.getKey()));
            if (!known) {
                turns.add(new TraceDtos.Turn(entry.getKey(), "UNKNOWN", null, null, null,
                        preview(questionByRun.get(entry.getKey()), 200), null, null, entry.getValue()));
            }
        }

        String title = conversationRepo.findById(conversationId)
                .map(Conversation::getTitle).orElse(null);
        return new TraceDtos.ConversationTrace(conversationId, title, turns.size(), turns);
    }

    @Transactional(readOnly = true)
    public List<TraceDtos.Span> spansOfRun(String runId) {
        return spanRepo.findByRunIdOrderBySpanSeqAsc(runId).stream().map(this::toSpan).toList();
    }

    @Transactional(readOnly = true)
    public List<TraceDtos.Span> spansOfConversation(String conversationId) {
        return spanRepo.findByConversationIdOrderByStartedAtAscSpanSeqAsc(conversationId)
                .stream().map(this::toSpan).toList();
    }

    /** 某个 agent 最近的运行（轨迹页的入口列表）。 */
    @Transactional(readOnly = true)
    public List<TraceDtos.RunSummary> recentRuns(String agentId, int limit) {
        return runRepo.findByAgentIdOrderByStartedAtDesc(agentId).stream()
                .limit(Math.max(1, Math.min(limit, 100)))
                .map(run -> new TraceDtos.RunSummary(
                        run.getId(), run.getStatus().name(), run.getRetryOfRunId(),
                        run.getStartedAt(), run.getFinishedAt(), durationOf(run),
                        preview(run.getAnswer()), spanRepo.countByRunId(run.getId())))
                .toList();
    }

    private static Long durationOf(Run run) {
        if (run.getStartedAt() == null || run.getFinishedAt() == null) {
            return null;
        }
        return Math.max(0, run.getFinishedAt().toEpochMilli() - run.getStartedAt().toEpochMilli());
    }

    private static String preview(String text) {
        return preview(text, 80);
    }

    private static String preview(String text, int max) {
        if (text == null) {
            return null;
        }
        String flat = text.replace('\n', ' ').trim();
        return flat.length() <= max ? flat : flat.substring(0, max) + "…";
    }

    private TraceDtos.Span toSpan(local.agentstack.domain.TraceSpan span) {
        return new TraceDtos.Span(span.getId(), span.getRunId(), span.getSpanSeq(), span.getKind(), span.getName(),
                span.getNodeId(), span.getStatus(), span.getStartedAt(), span.getEndedAt(),
                span.getDurationMs(), read(span.getInputJson()), read(span.getOutputJson()),
                read(span.getAttributesJson()), span.getErrorText());
    }

    private JsonNode read(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            // 库里存的是历史数据，格式异常不该让整个轨迹页 500
            return mapper.getNodeFactory().textNode(json);
        }
    }
}
