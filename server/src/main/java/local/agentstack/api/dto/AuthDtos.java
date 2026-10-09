package local.agentstack.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.Instant;

public final class AuthDtos {

    private AuthDtos() {
    }

    public record RegisterRequest(
            @NotBlank @Size(max = 190) String email,
            @NotBlank @Size(max = 64) String displayName,
            @NotBlank @Size(min = 8, max = 128) String password) {
    }

    public record LoginRequest(
            @NotBlank String email,
            @NotBlank String password) {
    }

    public record UserView(String id, String email, String displayName, Instant createdAt) {
    }

    public record AuthResponse(String token, UserView user) {
    }
}
