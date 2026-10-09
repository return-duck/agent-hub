package local.agentstack.api.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.Min;

import java.time.Instant;
import java.util.Map;

public final class RunDtos {

    private RunDtos() {
    }

    /**
     * 会话回退请求：保留 seq &lt;= keepSeq 的消息，其余（含其所属 run 与轨迹）删除。
     *
     * 「修改上一条消息并重发」就是 keepSeq = 上一条 user 消息的 seq - 1。
     */
    public record RewindRequest(@Min(0) int keepSeq) {
    }

    /** 公开页面的回退请求：访客身份放在请求体里，与其他公开接口保持一致。 */
    public record PublicRewindRequest(@Min(0) int keepSeq, String visitorId) {
    }

    /** conversationId 为 null 时新建会话；否则在该会话上追加一轮。 */
    public record StartRequest(Map<String, Object> input, String conversationId) {
    }

    public record StartResponse(String runId, String conversationId) {
    }

    public record RunView(
            String id,
            String agentId,
            String conversationId,
            String status,
            JsonNode input,
            String answer,
            JsonNode error,
            Instant startedAt,
            Instant finishedAt) {
    }

    public record MessageView(
            String id,
            String runId,
            int seq,
            String role,
            String content,
            JsonNode toolCalls,
            Instant createdAt) {
    }
}
