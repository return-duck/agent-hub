package local.agentstack.api.dto;

import java.time.Instant;

public final class ConversationDtos {

    private ConversationDtos() {
    }

    /**
     * 会话摘要。fromVisitor 用来区分"公开页面访客开的会话"与"工作室里自己开的会话"，
     * 前者在会话列表里会打上标记。
     */
    public record Summary(
            String id,
            String title,
            boolean fromVisitor,
            long messageCount,
            Instant createdAt) {
    }
}
