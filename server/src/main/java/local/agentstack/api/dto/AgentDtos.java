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
            boolean published,
            String publicSlug,
            Instant createdAt,
            Instant updatedAt) {
    }

    public record Detail(
            String id,
            String name,
            String description,
            int graphSchemaVersion,
            JsonNode graph,
            boolean published,
            String publicSlug,
            Instant publishedAt,
            Instant createdAt,
            Instant updatedAt) {
    }

    /**
     * 公开页面能看到的 agent 信息：只暴露展示所需字段，
     * 刻意不含 graph —— 分享页的访客没有理由拿到编排细节。
     */
    public record PublicView(
            String slug,
            String name,
            String description,
            Instant publishedAt) {
    }

    /** 发布结果：slug 即公开链接里的那一段。 */
    public record PublishResult(String slug, String publicPath, boolean published) {
    }
}
