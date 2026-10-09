package local.agentstack.api.dto;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;

public final class TraceDtos {

    private TraceDtos() {
    }

    /**
     * 一条调用轨迹。kind 决定前端用什么图标/标签展示：
     * node（画布节点）/ model（模型调用）/ tool / mcp / skill。
     */
    public record Span(
            String id,
            int spanSeq,
            String kind,
            String name,
            String nodeId,
            String status,
            Instant startedAt,
            Instant endedAt,
            Integer durationMs,
            JsonNode input,
            JsonNode output,
            JsonNode attributes,
            String error) {
    }

    /** 轨迹页左侧的运行列表。spanCount 让"这次跑了多少步"一眼可见。 */
    public record RunSummary(
            String id,
            String status,
            String retryOfRunId,
            Instant startedAt,
            Instant finishedAt,
            Long durationMs,
            String answerPreview,
            long spanCount) {
    }
}
