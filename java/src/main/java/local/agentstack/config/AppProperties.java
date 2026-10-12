package local.agentstack.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

@ConfigurationProperties(prefix = "app")
public record AppProperties(Runtime runtime, Cors cors) {

    public record Runtime(String baseUrl, long executeTimeoutMs) {
    }

    public record Cors(List<String> allowedOrigins) {
    }
}
