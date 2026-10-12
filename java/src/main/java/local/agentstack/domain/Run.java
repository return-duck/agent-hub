package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "run")
public class Run {

    @Id
    @Column(name = "id", length = 36, nullable = false)
    private String id;

    @Column(name = "conversation_id", length = 36, nullable = false)
    private String conversationId;

    @Column(name = "agent_id", length = 36, nullable = false)
    private String agentId;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", length = 16, nullable = false)
    private RunStatus status;

    /** 这一轮是重试哪一次 run（断点重试的血缘，便于轨迹页把重试串起来） */
    @Column(name = "retry_of_run_id", length = 36)
    private String retryOfRunId;

    @Column(name = "input_json", columnDefinition = "LONGTEXT")
    private String inputJson;

    @Column(name = "answer", columnDefinition = "LONGTEXT")
    private String answer;

    @Column(name = "error_json", columnDefinition = "LONGTEXT")
    private String errorJson;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    protected Run() {
    }

    public Run(String id, String conversationId, String agentId, RunStatus status, String inputJson,
               Instant startedAt) {
        this.id = id;
        this.conversationId = conversationId;
        this.agentId = agentId;
        this.status = status;
        this.inputJson = inputJson;
        this.startedAt = startedAt;
    }

    public void markRetryOf(String originalRunId) {
        this.retryOfRunId = originalRunId;
    }

    public String getRetryOfRunId() {
        return retryOfRunId;
    }

    public void markRunning() {
        this.status = RunStatus.RUNNING;
    }

    public void markSucceeded(String answer, Instant finishedAt) {
        this.status = RunStatus.SUCCEEDED;
        this.answer = answer;
        this.finishedAt = finishedAt;
    }

    /**
     * 被用户中断。
     *
     * 刻意保留已经产出的部分回答：中断的语义是"停下来"，不是"这次白跑了" ——
     * 用户接下来要么修改上一条消息重发，要么直接原样重试，两种都需要看到已经跑出什么。
     */
    public void markCancelled(String partialAnswer, Instant finishedAt) {
        this.status = RunStatus.CANCELLED;
        this.answer = partialAnswer;
        this.finishedAt = finishedAt;
    }

    public void markFailed(String errorJson, Instant finishedAt) {
        this.status = RunStatus.FAILED;
        this.errorJson = errorJson;
        this.finishedAt = finishedAt;
    }

    public String getId() {
        return id;
    }

    public String getConversationId() {
        return conversationId;
    }

    public String getAgentId() {
        return agentId;
    }

    public RunStatus getStatus() {
        return status;
    }

    public String getInputJson() {
        return inputJson;
    }

    public String getAnswer() {
        return answer;
    }

    public String getErrorJson() {
        return errorJson;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getFinishedAt() {
        return finishedAt;
    }
}
