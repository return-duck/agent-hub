package local.agentstack.api.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.Instant;

public final class AgentDtos {

    private AgentDtos() {
    }

    /** 新建 / 保存。graph 直接就是画布结构（React Flow 的 nodes/edges）。 */
    public record SaveRequest(
            @NotBlank @Size(max = 128) String name,
            @Size(max = 512) String description,
            @NotNull JsonNode graph) {
    }

    public record Summary(
            String id,
            String name,
            String description,
            int graphSchemaVersion,
            int nodeCount,
            Instant createdAt,
            Instant updatedAt) {
    }

    public record Detail(
            String id,
            String name,
            String description,
            int graphSchemaVersion,
            JsonNode graph,
            Instant createdAt,
            Instant updatedAt) {
    }
}
