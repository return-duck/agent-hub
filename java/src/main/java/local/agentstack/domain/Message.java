package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "message")
public class Message {

    @Id
    @Column(name = "id", length = 36, nullable = false)
    private String id;

    @Column(name = "conversation_id", length = 36, nullable = false)
    private String conversationId;

    @Column(name = "run_id", length = 36)
    private String runId;

    /** 会话内单调序号，用于稳定排序与多轮历史拼装 */
    @Column(name = "seq", nullable = false)
    private int seq;

    @Column(name = "role", length = 16, nullable = false)
    private String role;

    @Column(name = "content", columnDefinition = "LONGTEXT")
    private String content;

    @Column(name = "tool_calls_json", columnDefinition = "LONGTEXT")
    private String toolCallsJson;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Message() {
    }

    public Message(String id, String conversationId, String runId, int seq, String role, String content,
                   String toolCallsJson, Instant createdAt) {
        this.id = id;
        this.conversationId = conversationId;
        this.runId = runId;
        this.seq = seq;
        this.role = role;
        this.content = content;
        this.toolCallsJson = toolCallsJson;
        this.createdAt = createdAt;
    }

    public String getId() {
        return id;
    }

    public String getConversationId() {
        return conversationId;
    }

    public String getRunId() {
        return runId;
    }

    public int getSeq() {
        return seq;
    }

    public String getRole() {
        return role;
    }

    public String getContent() {
        return content;
    }

    public String getToolCallsJson() {
        return toolCallsJson;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
