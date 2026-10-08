package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "conversation")
public class Conversation {

    @Id
    @Column(name = "id", length = 36, nullable = false)
    private String id;

    @Column(name = "agent_id", length = 36, nullable = false)
    private String agentId;

    @Column(name = "title", length = 255)
    private String title;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Conversation() {
    }

    public Conversation(String id, String agentId, String title, Instant createdAt) {
        this.id = id;
        this.agentId = agentId;
        this.title = title;
        this.createdAt = createdAt;
    }

    public String getId() {
        return id;
    }

    public String getAgentId() {
        return agentId;
    }

    public String getTitle() {
        return title;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
