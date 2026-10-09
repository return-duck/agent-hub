package local.agentstack.api.dto;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;

public final class TraceDtos {

    private TraceDtos() {
    }

    /**
     * 一条调用轨迹。kind 决定前端用什么图标/标签展示：
     * node（画布节点）/ model（模型调用）/ tool / mcp / skill。
     */
    public record Span(
            String id,
            /** 属于哪一轮对话。前端据此把一个会话里的多轮轨迹分组展示 */
            String runId,
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

    /**
     * 一轮对话的轨迹。
     *
     * question / answerPreview 让这一轮"问的是什么、答了什么"直接可读，
     * 不必先去消息接口里对照 runId 才能看懂轨迹。
     */
    public record Turn(
            String runId,
            String status,
            Instant startedAt,
            Instant finishedAt,
            Long durationMs,
            String question,
            String answerPreview,
            String error,
            List<Span> spans) {
    }

    /** 一个会话的完整调用轨迹：多轮对话在同一页展示 */
    public record ConversationTrace(
            String conversationId,
            String title,
            int turnCount,
            List<Turn> turns) {
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
