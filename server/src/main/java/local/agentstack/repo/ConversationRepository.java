package local.agentstack.repo;

import local.agentstack.domain.Conversation;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ConversationRepository extends JpaRepository<Conversation, String> {

    List<Conversation> findByAgentIdOrderByCreatedAtDesc(String agentId);
}
