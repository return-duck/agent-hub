package local.agentstack.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/** 平台用户。密码只存 PBKDF2 的 hash 与 salt，不存明文、也不可逆。 */
@Entity
@Table(name = "app_user")
public class AppUser {

    @Id
    @Column(name = "id", length = 36, nullable = false)
    private String id;

    /** 登录名，统一按小写归一化后存储，避免 Foo@x 与 foo@x 变成两个账号 */
    @Column(name = "email", length = 190, nullable = false)
    private String email;

    @Column(name = "display_name", length = 64, nullable = false)
    private String displayName;

    @Column(name = "password_hash", length = 255, nullable = false)
    private String passwordHash;

    @Column(name = "password_salt", length = 64, nullable = false)
    private String passwordSalt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected AppUser() {
    }

    public AppUser(String id, String email, String displayName, String passwordHash, String passwordSalt,
                   Instant createdAt) {
        this.id = id;
        this.email = email;
        this.displayName = displayName;
        this.passwordHash = passwordHash;
        this.passwordSalt = passwordSalt;
        this.createdAt = createdAt;
    }

    public String getId() {
        return id;
    }

    public String getEmail() {
        return email;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public String getPasswordSalt() {
        return passwordSalt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
