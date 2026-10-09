package local.agentstack.auth;

import local.agentstack.domain.AppUser;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;

/**
 * 鉴权拦截器：把 /api/** 收口成"必须带有效令牌"，公开路径在 WebConfig 里排除。
 *
 * 之所以不引 spring-security：本项目只需要"令牌 → 用户"这一件事，
 * 引入整套过滤器链会让错误体、CORS、SSE 三处的行为都要重新对齐。
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    public static final String USER_ATTRIBUTE = "agentstack.currentUser";
    public static final String TOKEN_ATTRIBUTE = "agentstack.currentToken";

    private final AuthService auth;

    public AuthInterceptor(AuthService auth) {
        this.auth = auth;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws IOException {
        // CORS 预检不携带 Authorization，必须放行，否则浏览器连正式请求都发不出去
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        String token = extractToken(request);
        Optional<AppUser> user = auth.resolve(token);
        if (user.isEmpty()) {
            writeUnauthorized(response);
            return false;
        }
        request.setAttribute(USER_ATTRIBUTE, user.get());
        request.setAttribute(TOKEN_ATTRIBUTE, token);
        return true;
    }

    /** 同时支持标准的 Authorization: Bearer 与简写的 X-Auth-Token。 */
    static String extractToken(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header != null) {
            String trimmed = header.trim();
            if (trimmed.regionMatches(true, 0, "Bearer ", 0, 7)) {
                return trimmed.substring(7).trim();
            }
            if (!trimmed.isEmpty()) {
                return trimmed;
            }
        }
        String alt = request.getHeader("X-Auth-Token");
        return alt == null ? null : alt.trim();
    }

    private void writeUnauthorized(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write("{\"code\":\"UNAUTHORIZED\",\"message\":\"请先登录\",\"details\":[],\"ts\":\""
                + Instant.now() + "\"}");
    }
}
