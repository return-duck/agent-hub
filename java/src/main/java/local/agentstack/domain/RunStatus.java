package local.agentstack.domain;

public enum RunStatus {
    QUEUED,
    RUNNING,
    SUCCEEDED,
    FAILED,
    /** 被用户主动中断。已产出的事件与消息仍然有效，可据此重试或修改后重发。 */
    CANCELLED;

    public boolean isTerminal() {
        return this == SUCCEEDED || this == FAILED || this == CANCELLED;
    }
}
