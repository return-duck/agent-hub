package local.agentstack.repo;

import local.agentstack.domain.Message;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MessageRepository extends JpaRepository<Message, String> {

    List<Message> findByConversationIdOrderBySeqAsc(String conversationId);

    List<Message> findByRunIdOrderBySeqAsc(String runId);

    long countByConversationId(String conversationId);

    @Query("select coalesce(max(m.seq), 0) from Message m where m.conversationId = :conversationId")
    int findMaxSeq(@Param("conversationId") String conversationId);
}
