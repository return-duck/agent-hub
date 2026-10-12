package local.agentstack.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.config.AppProperties;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 把一次 run 交给 runtime 执行，并以 NDJSON 流的形式读回协议事件。
 *
 * 关键点：Java 侧不做模型调用，只消费事件流 —— 执行循环完整地留在 LangGraph 内，
 * 否则 interrupt / checkpointer / streamEvents 这些"循环级"能力会全部退化成手写状态机。
 */
@Component
public class RuntimeClient {

    private final HttpClient http;
    private final ObjectMapper mapper;
    private final AppProperties props;

    public RuntimeClient(ObjectMapper mapper, AppProperties props) {
        this.mapper = mapper;
        this.props = props;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    public record HistoryMessage(String role, String content) {
    }

    public record ExecuteRequest(
            String runId,
            String conversationId,
            JsonNode graph,
            int graphSchemaVersion,
            Map<String, Object> input,
            List<HistoryMessage> history) {
    }

    /** 打开事件流。调用方负责 close（try-with-resources）。 */
    public Stream<String> execute(ExecuteRequest request) {
        HttpRequest httpRequest;
        try {
            String body = mapper.writeValueAsString(request);
            httpRequest = HttpRequest.newBuilder(URI.create(props.runtime().baseUrl() + "/execute"))
                    .timeout(Duration.ofMillis(props.runtime().executeTimeoutMs()))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .header("Accept", "application/x-ndjson")
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
        } catch (IOException e) {
            throw new RuntimeCallException(0, "构造 runtime 请求失败: " + e.getMessage(), e);
        }

        try {
            HttpResponse<Stream<String>> response = http.send(httpRequest, HttpResponse.BodyHandlers.ofLines());
            if (response.statusCode() != 200) {
                String detail = response.body().collect(Collectors.joining("\n"));
                throw new RuntimeCallException(response.statusCode(), "runtime 返回 " + response.statusCode() + ": " + detail, null);
            }
            return response.body();
        } catch (IOException e) {
            throw new RuntimeCallException(0, "无法连接 runtime (" + props.runtime().baseUrl() + "): " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeCallException(0, "等待 runtime 响应被中断", e);
        }
    }

    public record Health(boolean ok, String modelMode, String modelName) {
    }

    /** 探测 runtime 与模型状态，供 /api/capabilities 与前端横幅使用。 */
    public Health health() {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(props.runtime().baseUrl() + "/healthz"))
                    .timeout(Duration.ofSeconds(5))
                    .GET()
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                return new Health(false, null, null);
            }
            JsonNode node = mapper.readTree(response.body());
            JsonNode model = node.path("model");
            return new Health(true, model.path("mode").asText(null), model.path("name").asText(null));
        } catch (IOException e) {
            return new Health(false, null, null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new UncheckedIOException(new IOException(e));
        }
    }

    public static class RuntimeCallException extends RuntimeException {

        private final int statusCode;

        public RuntimeCallException(int statusCode, String message, Throwable cause) {
            super(message, cause);
            this.statusCode = statusCode;
        }

        public int getStatusCode() {
            return statusCode;
        }
    }
}
