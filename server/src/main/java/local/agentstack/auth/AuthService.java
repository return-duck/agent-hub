package local.agentstack.auth;

import local.agentstack.api.ApiException;
import local.agentstack.domain.AppUser;
import local.agentstack.domain.Timestamps;
import local.agentstack.domain.UserSession;
import local.agentstack.repo.AppUserRepository;
import local.agentstack.repo.UserSessionRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/** 注册 / 登录 / 令牌校验。 */
@Service
public class AuthService {

    /** 令牌有效期 30 天。到期后需要重新登录，避免永久有效的凭据长期漂在外面。 */
    private static final Duration TOKEN_TTL = Duration.ofDays(30);
    private static final int MIN_PASSWORD_LENGTH = 8;
    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s.]+\\.[^@\\s]+$");

    private final AppUserRepository userRepo;
    private final UserSessionRepository sessionRepo;
    private final PasswordHasher hasher;
    private final SecureRandom random = new SecureRandom();

    public AuthService(AppUserRepository userRepo, UserSessionRepository sessionRepo, PasswordHasher hasher) {
        this.userRepo = userRepo;
        this.sessionRepo = sessionRepo;
        this.hasher = hasher;
    }

    public record Issued(String token, AppUser user) {
    }

    @Transactional
    public Issued register(String rawEmail, String displayName, String rawPassword) {
        String email = normalizeEmail(rawEmail);
        if (!EMAIL.matcher(email).matches()) {
            throw ApiException.invalid("邮箱格式不正确");
        }
        String name = displayName == null ? "" : displayName.trim();
        if (name.isEmpty() || name.length() > 64) {
            throw ApiException.invalid("昵称需要 1-64 个字符");
        }
        if (rawPassword == null || rawPassword.length() < MIN_PASSWORD_LENGTH) {
            throw ApiException.invalid("密码至少 " + MIN_PASSWORD_LENGTH + " 位");
        }
        if (userRepo.existsByEmail(email)) {
            throw ApiException.conflict("该邮箱已注册：" + email);
        }

        String salt = hasher.newSalt();
        AppUser user = new AppUser(UUID.randomUUID().toString(), email, name,
                hasher.hash(rawPassword, salt), salt, Timestamps.now());
        try {
            userRepo.saveAndFlush(user);
        } catch (DataIntegrityViolationException e) {
            // 并发注册同一邮箱时唯一索引会先拦下来
            throw ApiException.conflict("该邮箱已注册：" + email);
        }
        return issue(user);
    }

    @Transactional
    public Issued login(String rawEmail, String rawPassword) {
        String email = normalizeEmail(rawEmail);
        AppUser user = userRepo.findByEmail(email).orElse(null);
        // 账号不存在与密码错误返回同一个错误体，避免变成账号枚举接口
        if (user == null || !hasher.matches(rawPassword == null ? "" : rawPassword,
                user.getPasswordSalt(), user.getPasswordHash())) {
            throw ApiException.unauthorized("邮箱或密码不正确");
        }
        return issue(user);
    }

    @Transactional
    public void logout(String rawToken) {
        if (rawToken != null && !rawToken.isBlank()) {
            sessionRepo.deleteById(sha256Hex(rawToken));
        }
    }

    @Transactional(readOnly = true)
    public Optional<AppUser> resolve(String rawToken) {
        if (rawToken == null || rawToken.isBlank()) {
            return Optional.empty();
        }
        return sessionRepo.findById(sha256Hex(rawToken))
                .filter(session -> session.getExpiresAt().isAfter(Instant.now()))
                .flatMap(session -> userRepo.findById(session.getUserId()));
    }

    @Transactional
    public int purgeExpiredSessions() {
        return sessionRepo.deleteExpired(Timestamps.now());
    }

    private Issued issue(AppUser user) {
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        Instant now = Timestamps.now();
        sessionRepo.save(new UserSession(sha256Hex(token), user.getId(), now, now.plus(TOKEN_TTL)));
        return new Issued(token, user);
    }

    static String normalizeEmail(String raw) {
        return raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.ROOT);
    }

    /** 库里只存令牌的 SHA-256，泄库也无法直接冒充。 */
    static String sha256Hex(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }
}
