package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "agent")
public class Agent {

    @Id
    @Column(name = "id", length = 36, nullable = false)
    private String id;

    /** 归属用户。V1 时代建的 agent 为 null（部署期的验证数据），不属于任何用户。 */
    @Column(name = "owner_id", length = 36)
    private String ownerId;

    @Column(name = "name", length = 128, nullable = false)
    private String name;

    @Column(name = "description", length = 512)
    private String description;

    /** 契约 contracts/agent-graph.schema.json 的原文，字节级往返保存 */
    @Column(name = "graph_json", columnDefinition = "LONGTEXT", nullable = false)
    private String graphJson;

    @Column(name = "graph_schema_version", nullable = false)
    private int graphSchemaVersion = 1;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "published", nullable = false)
    private boolean published;

    /** 发布后的公开链接标识。取消发布后保留，重新发布即复用同一个 URL。 */
    @Column(name = "public_slug", length = 64)
    private String publicSlug;

    @Column(name = "published_at")
    private Instant publishedAt;

    protected Agent() {
    }

    public Agent(String id, String ownerId, String name, String description, String graphJson,
                 int graphSchemaVersion, Instant createdAt) {
        this.id = id;
        this.ownerId = ownerId;
        this.name = name;
        this.description = description;
        this.graphJson = graphJson;
        this.graphSchemaVersion = graphSchemaVersion;
        this.createdAt = createdAt;
        this.updatedAt = createdAt;
    }

    public void update(String name, String description, String graphJson, int graphSchemaVersion, Instant now) {
        this.name = name;
        this.description = description;
        this.graphJson = graphJson;
        this.graphSchemaVersion = graphSchemaVersion;
        this.updatedAt = now;
    }

    public void publish(String slug, Instant now) {
        this.published = true;
        this.publicSlug = slug;
        this.publishedAt = now;
    }

    public void unpublish() {
        this.published = false;
    }

    public String getId() {
        return id;
    }

    public String getOwnerId() {
        return ownerId;
    }

    public boolean isPublished() {
        return published;
    }

    public String getPublicSlug() {
        return publicSlug;
    }

    public Instant getPublishedAt() {
        return publishedAt;
    }

    public String getName() {
        return name;
    }

    public String getDescription() {
        return description;
    }

    public String getGraphJson() {
        return graphJson;
    }

    public int getGraphSchemaVersion() {
        return graphSchemaVersion;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
