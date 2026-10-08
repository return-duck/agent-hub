package local.agentstack.repo;

import local.agentstack.domain.RunEvent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface RunEventRepository extends JpaRepository<RunEvent, Long> {

    List<RunEvent> findByRunIdAndSeqGreaterThanOrderBySeqAsc(String runId, int afterSeq);

    List<RunEvent> findByRunIdOrderBySeqAsc(String runId);
}
