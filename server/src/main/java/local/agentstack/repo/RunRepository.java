package local.agentstack.repo;

import local.agentstack.domain.Run;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface RunRepository extends JpaRepository<Run, String> {

    List<Run> findByConversationIdOrderByStartedAtDesc(String conversationId);

    List<Run> findByAgentIdOrderByStartedAtDesc(String agentId);

    Optional<Run> findFirstByConversationIdOrderByStartedAtDesc(String conversationId);
}
