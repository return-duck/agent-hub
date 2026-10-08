package local.agentstack.repo;

import local.agentstack.domain.Agent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface AgentRepository extends JpaRepository<Agent, String> {

    List<Agent> findAllByOrderByUpdatedAtDesc();

    boolean existsByName(String name);
}
