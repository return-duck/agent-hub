package local.agentstack.repo;

import local.agentstack.domain.Conversation;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ConversationRepository extends JpaRepository<Conversation, String> {

    List<Conversation> findByAgentIdOrderByCreatedAtDesc(String agentId);

    List<Conversation> findByAgentIdAndVisitorIdOrderByCreatedAtDesc(String agentId, String visitorId);

    /**
     * 取会话并加行锁。
     *
     * 用途：同一会话上并发发起两轮时，把"检查是否有进行中的轮次"和"插入新 run"
     * 串行化，否则两个请求会各自算出同一个 seq，撞上 message 的 (conversation_id, seq) 唯一约束，
     * 导致其中一轮整轮丢失（这个 bug 是被 UserPublishIT 抓出来的）。
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from Conversation c where c.id = :id")
    Optional<Conversation> lockById(@Param("id") String id);
}
