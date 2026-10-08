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

    protected Agent() {
    }

    public Agent(String id, String name, String description, String graphJson, int graphSchemaVersion,
                 Instant createdAt) {
        this.id = id;
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

    public String getId() {
        return id;
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
