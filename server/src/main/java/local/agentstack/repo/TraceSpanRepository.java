package local.agentstack.repo;

import local.agentstack.domain.TraceSpan;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface TraceSpanRepository extends JpaRepository<TraceSpan, String> {

    List<TraceSpan> findByRunIdOrderBySpanSeqAsc(String runId);

    List<TraceSpan> findByConversationIdOrderByStartedAtAscSpanSeqAsc(String conversationId);

    List<TraceSpan> findByAgentIdOrderByStartedAtDesc(String agentId);

    long countByRunId(String runId);
}
