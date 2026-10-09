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

    /** 会话回退用：找出要删掉的那一段消息 */
    List<Message> findByConversationIdAndSeqGreaterThanOrderBySeqAsc(String conversationId, int seq);

    /** 断点重试用：找出某一轮的 user 消息，确定回退位置 */
    java.util.Optional<Message> findFirstByRunIdAndRoleOrderBySeqAsc(String runId, String role);

    @Query("select coalesce(max(m.seq), 0) from Message m where m.conversationId = :conversationId")
    int findMaxSeq(@Param("conversationId") String conversationId);
}
