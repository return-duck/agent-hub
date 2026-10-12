package local.agentstack.api;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import local.agentstack.api.dto.AuthDtos;
import local.agentstack.auth.AuthInterceptor;
import local.agentstack.auth.AuthService;
import local.agentstack.auth.CurrentUser;
import local.agentstack.domain.AppUser;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/register")
    public ResponseEntity<AuthDtos.AuthResponse> register(@Valid @RequestBody AuthDtos.RegisterRequest request) {
        AuthService.Issued issued = auth.register(request.email(), request.displayName(), request.password());
        return ResponseEntity.status(HttpStatus.CREATED).body(toResponse(issued));
    }

    @PostMapping("/login")
    public AuthDtos.AuthResponse login(@Valid @RequestBody AuthDtos.LoginRequest request) {
        return toResponse(auth.login(request.email(), request.password()));
    }

    /** 吊销当前令牌。前端拿到 204 后清掉本地 token 即可。 */
    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request) {
        Object token = request.getAttribute(AuthInterceptor.TOKEN_ATTRIBUTE);
        auth.logout(token == null ? null : token.toString());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/me")
    public AuthDtos.UserView me(@CurrentUser AppUser user) {
        return toView(user);
    }

    private AuthDtos.AuthResponse toResponse(AuthService.Issued issued) {
        return new AuthDtos.AuthResponse(issued.token(), toView(issued.user()));
    }

    private AuthDtos.UserView toView(AppUser user) {
        return new AuthDtos.UserView(user.getId(), user.getEmail(), user.getDisplayName(), user.getCreatedAt());
    }
}
