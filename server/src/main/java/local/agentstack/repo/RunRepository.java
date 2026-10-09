package local.agentstack.repo;

import local.agentstack.domain.Run;
import local.agentstack.domain.RunStatus;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface RunRepository extends JpaRepository<Run, String> {

    List<Run> findByConversationIdOrderByStartedAtDesc(String conversationId);

    List<Run> findByAgentIdOrderByStartedAtDesc(String agentId);

    Optional<Run> findFirstByConversationIdOrderByStartedAtDesc(String conversationId);

    long countByConversationIdAndStatusIn(String conversationId, Collection<RunStatus> statuses);

    List<Run> findByConversationIdAndStatusIn(String conversationId, Collection<RunStatus> statuses);

    /** 该会话是否还有未结束的轮次（用于阻止并发，避免 seq 撞车）。 */
    boolean existsByConversationIdAndStatusIn(String conversationId, Collection<RunStatus> statuses);
}
