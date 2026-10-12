package local.agentstack.api;

import java.util.List;
import java.util.Map;

/**
 * 统一的 API 错误体。code 是机器可读的稳定标识，details 可携带逐节点的校验问题。
 */
public class ApiException extends RuntimeException {

    private final String code;
    private final int status;
    private final List<Map<String, Object>> details;

    public ApiException(String code, int status, String message) {
        this(code, status, message, List.of());
    }

    public ApiException(String code, int status, String message, List<Map<String, Object>> details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details == null ? List.of() : details;
    }

    public static ApiException notFound(String what, String id) {
        return new ApiException("NOT_FOUND", 404, what + " 不存在: " + id);
    }

    public static ApiException invalid(String message) {
        return new ApiException("INVALID_REQUEST", 400, message);
    }

    public static ApiException invalidGraph(String message, List<Map<String, Object>> details) {
        return new ApiException("INVALID_GRAPH", 400, message, details);
    }

    public static ApiException conflict(String message) {
        return new ApiException("CONFLICT", 409, message);
    }

    public static ApiException unauthorized(String message) {
        return new ApiException("UNAUTHORIZED", 401, message);
    }

    public static ApiException forbidden(String message) {
        return new ApiException("FORBIDDEN", 403, message);
    }

    public static ApiException runtimeUnavailable(String message) {
        return new ApiException("RUNTIME_UNAVAILABLE", 503, message);
    }

    public String getCode() {
        return code;
    }

    public int getStatus() {
        return status;
    }

    public List<Map<String, Object>> getDetails() {
        return details;
    }
}
