package local.agentstack.repo;

import local.agentstack.domain.Agent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface AgentRepository extends JpaRepository<Agent, String> {

    List<Agent> findByOwnerIdOrderByUpdatedAtDesc(String ownerId);

    Optional<Agent> findByPublicSlugAndPublishedTrue(String publicSlug);

    boolean existsByPublicSlug(String publicSlug);

    List<Agent> findAllByOrderByUpdatedAtDesc();

    boolean existsByName(String name);
}
