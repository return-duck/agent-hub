package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * 一条调用轨迹（span）。
 *
 * 一次 run 会被拆成若干 span：画布节点、模型调用、工具/MCP/技能调用。
 * 持久化的意义是"事后可查"—— 出问题时能翻出当时到底给模型发了什么、模型回了什么、
 * 调了哪个工具、参数与结果是什么，而不是只剩一句"运行失败"。
 */
@Entity
@Table(name = "trace_span")
public class TraceSpan {

    @Id
    @Column(name = "id", length = 36, nullable = false)
    private String id;

    @Column(name = "run_id", length = 36, nullable = false)
    private String runId;

    @Column(name = "conversation_id", length = 36, nullable = false)
    private String conversationId;

    @Column(name = "agent_id", length = 36, nullable = false)
    private String agentId;

    /** 同一 run 内从 1 开始递增，反映真实发生顺序 */
    @Column(name = "span_seq", nullable = false)
    private int spanSeq;

    /** node | model | tool | mcp | skill */
    @Column(name = "kind", length = 16, nullable = false)
    private String kind;

    @Column(name = "name", length = 160, nullable = false)
    private String name;

    @Column(name = "node_id", length = 64)
    private String nodeId;

    /** ok | error | cancelled */
    @Column(name = "status", length = 16, nullable = false)
    private String status;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    @Column(name = "duration_ms")
    private Integer durationMs;

    @Column(name = "input_json", columnDefinition = "LONGTEXT")
    private String inputJson;

    @Column(name = "output_json", columnDefinition = "LONGTEXT")
    private String outputJson;

    @Column(name = "attributes_json", columnDefinition = "LONGTEXT")
    private String attributesJson;

    @Column(name = "error_text", length = 1024)
    private String errorText;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected TraceSpan() {
    }

    public TraceSpan(String id, String runId, String conversationId, String agentId, int spanSeq,
                     String kind, String name, String nodeId, String status,
                     Instant startedAt, Instant endedAt, Integer durationMs,
                     String inputJson, String outputJson, String attributesJson, String errorText,
                     Instant createdAt) {
        this.id = id;
        this.runId = runId;
        this.conversationId = conversationId;
        this.agentId = agentId;
        this.spanSeq = spanSeq;
        this.kind = kind;
        this.name = name;
        this.nodeId = nodeId;
        this.status = status;
        this.startedAt = startedAt;
        this.endedAt = endedAt;
        this.durationMs = durationMs;
        this.inputJson = inputJson;
        this.outputJson = outputJson;
        this.attributesJson = attributesJson;
        this.errorText = errorText;
        this.createdAt = createdAt;
    }

    public String getId() {
        return id;
    }

    public String getRunId() {
        return runId;
    }

    public String getConversationId() {
        return conversationId;
    }

    public String getAgentId() {
        return agentId;
    }

    public int getSpanSeq() {
        return spanSeq;
    }

    public String getKind() {
        return kind;
    }

    public String getName() {
        return name;
    }

    public String getNodeId() {
        return nodeId;
    }

    public String getStatus() {
        return status;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getEndedAt() {
        return endedAt;
    }

    public Integer getDurationMs() {
        return durationMs;
    }

    public String getInputJson() {
        return inputJson;
    }

    public String getOutputJson() {
        return outputJson;
    }

    public String getAttributesJson() {
        return attributesJson;
    }

    public String getErrorText() {
        return errorText;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
