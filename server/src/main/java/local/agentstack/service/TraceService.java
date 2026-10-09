package local.agentstack.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.api.dto.TraceDtos;
import local.agentstack.domain.Run;
import local.agentstack.repo.RunRepository;
import local.agentstack.repo.TraceSpanRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 调用轨迹的读取。写入在 TraceRecorder（随事件流投影），这里只管查询。 */
@Service
public class TraceService {

    private final TraceSpanRepository spanRepo;
    private final RunRepository runRepo;
    private final ObjectMapper mapper;

    public TraceService(TraceSpanRepository spanRepo, RunRepository runRepo, ObjectMapper mapper) {
        this.spanRepo = spanRepo;
        this.runRepo = runRepo;
        this.mapper = mapper;
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

    private static String preview(String answer) {
        if (answer == null) {
            return null;
        }
        String flat = answer.replace('\n', ' ').trim();
        return flat.length() <= 80 ? flat : flat.substring(0, 80) + "…";
    }

    private TraceDtos.Span toSpan(local.agentstack.domain.TraceSpan span) {
        return new TraceDtos.Span(span.getId(), span.getSpanSeq(), span.getKind(), span.getName(),
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
