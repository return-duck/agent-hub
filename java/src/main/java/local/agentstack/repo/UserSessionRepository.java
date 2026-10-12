package local.agentstack.repo;

import local.agentstack.domain.UserSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;

public interface UserSessionRepository extends JpaRepository<UserSession, String> {

    List<UserSession> findByUserId(String userId);

    @Modifying
    @Query("delete from UserSession s where s.expiresAt < :cutoff")
    int deleteExpired(@Param("cutoff") Instant cutoff);
}
