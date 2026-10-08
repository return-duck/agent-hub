package local.agentstack.api.dto;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.Map;

public final class RunDtos {

    private RunDtos() {
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
