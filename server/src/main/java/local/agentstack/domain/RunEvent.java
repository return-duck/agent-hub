package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * append-only 的运行事件。seq 由 server 作为唯一写入者分配，
 * (run_id, seq) 唯一约束让 SSE 续传天然可判重。
 */
@Entity
@Table(name = "run_event")
public class RunEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id")
    private Long id;

    @Column(name = "run_id", length = 36, nullable = false)
    private String runId;

    @Column(name = "seq", nullable = false)
    private int seq;

    @Column(name = "type", length = 48, nullable = false)
    private String type;

    @Column(name = "node_id", length = 64)
    private String nodeId;

    @Column(name = "payload_json", columnDefinition = "LONGTEXT", nullable = false)
    private String payloadJson;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected RunEvent() {
    }

    public RunEvent(String runId, int seq, String type, String nodeId, String payloadJson, Instant createdAt) {
        this.runId = runId;
        this.seq = seq;
        this.type = type;
        this.nodeId = nodeId;
        this.payloadJson = payloadJson;
        this.createdAt = createdAt;
    }

    public Long getId() {
        return id;
    }

    public String getRunId() {
        return runId;
    }

    public int getSeq() {
        return seq;
    }

    public String getType() {
        return type;
    }

    public String getNodeId() {
        return nodeId;
    }

    public String getPayloadJson() {
        return payloadJson;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
