package local.agentstack.api;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    /**
     * 显式指定 JSON 作为错误响应类型。
     *
     * 不这么做的话，SSE 端点（produces=text/event-stream）在鉴权失败时，
     * 会因为客户端 Accept 不是 application/json 而抛 HttpMediaTypeNotAcceptableException，
     * 把"404 未找到"变成"500 内部错误"，非常难查。
     */
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> handle(ApiException ex) {
        return ResponseEntity.status(ex.getStatus())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body(ex.getCode(), ex.getMessage(), ex.getDetails()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(MethodArgumentNotValidException ex) {
        List<Map<String, Object>> details = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> Map.<String, Object>of("field", fe.getField(), "message", String.valueOf(fe.getDefaultMessage())))
                .toList();
        return ResponseEntity.badRequest().contentType(MediaType.APPLICATION_JSON)
                .body(body("INVALID_REQUEST", "请求参数校验失败", details));
    }

    /**
     * 客户端 Accept 与端点 produces 不兼容（典型场景：用 Accept: application/json
     * 去请求 SSE 端点）。这属于客户端请求问题，回 406 才是对的 ——
     * 落到兜底分支会变成 500，排查时极具误导性。
     */
    @ExceptionHandler(HttpMediaTypeNotAcceptableException.class)
    public ResponseEntity<Map<String, Object>> handleNotAcceptable(HttpMediaTypeNotAcceptableException ex) {
        return ResponseEntity.status(HttpStatus.NOT_ACCEPTABLE)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body("NOT_ACCEPTABLE", "该端点的响应类型与 Accept 不匹配: " + ex.getMessage(), List.of()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleUnexpected(Exception ex) {
        log.error("未预期错误", ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body("INTERNAL", "服务内部错误: " + ex.getMessage(), List.of()));
    }

    private Map<String, Object> body(String code, String message, List<Map<String, Object>> details) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        body.put("details", details);
        body.put("ts", Instant.now().toString());
        return body;
    }
}
