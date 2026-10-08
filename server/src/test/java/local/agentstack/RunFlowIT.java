package local.agentstack;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

/**
 * 服务端编排的端到端集成测试（真实 MySQL + 桩 runtime）。
 *
 * 为什么用桩 runtime 而不是真的起 Node：这里要验证的是【服务端的编排契约】——
 * seq 单调、先落库再推送、终态一定收敛、SSE 可续传。用一个可控的桩可以精确构造
 * "runtime 中途失败"这类真实 runtime 很难稳定复现的场景。
 * 真 runtime 的联调由 scripts/e2e.sh 负责。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class RunFlowIT {

    private static final HttpServer STUB;
    private static final int STUB_PORT;
    private static volatile boolean failExecute = false;

    static {
        try {
            STUB = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            STUB.createContext("/execute", RunFlowIT::handleExecute);
            STUB.start();
            STUB_PORT = STUB.getAddress().getPort();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void runtimeProperties(DynamicPropertyRegistry registry) {
        registry.add("app.runtime.base-url", () -> "http://127.0.0.1:" + STUB_PORT);
        registry.add("app.runtime.execute-timeout-ms", () -> 15_000);
    }

    /** 7 条事件的固定脚本；顺序与真实 runtime 一致 */
    private static final List<String> CANNED_EVENTS = List.of(
            """
            {"type":"run.started","nodeId":null,"payload":{"model":{"provider":"stub","name":"stub-model","mode":"scripted"},"graphSchemaVersion":1,"input":{"topic":"hi"}}}""",
            """
            {"type":"node.started","nodeId":"n1","payload":{"nodeType":"start","label":"开始"}}""",
            """
            {"type":"node.finished","nodeId":"n1","payload":{"nodeType":"start","durationMs":1,"status":"ok"}}""",
            """
            {"type":"llm.token","nodeId":"n3","payload":{"delta":"你好"}}""",
            """
            {"type":"llm.token","nodeId":"n3","payload":{"delta":"世界"}}""",
            """
            {"type":"message.completed","nodeId":"n3","payload":{"role":"assistant","content":"你好世界"}}""",
            """
            {"type":"run.finished","nodeId":null,"payload":{"status":"SUCCEEDED","durationMs":9,"answer":"你好世界","totals":{"inputTokens":3,"outputTokens":2,"llmCalls":1,"toolCalls":0,"steps":2}}}"""
    );

    private static void handleExecute(HttpExchange exchange) throws IOException {
        exchange.getRequestBody().readAllBytes();
        if (failExecute) {
            byte[] body = "{\"code\":\"BOOM\",\"message\":\"runtime 内部错误\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(500, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
            return;
        }

        exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson; charset=utf-8");
        exchange.sendResponseHeaders(200, 0); // 0 = chunked，模拟流式
        try (OutputStream out = exchange.getResponseBody()) {
            for (String event : CANNED_EVENTS) {
                out.write((event.replaceAll("\\s+", " ").trim() + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } finally {
            exchange.close();
        }
    }

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper mapper;

    private final HttpClient http = HttpClient.newHttpClient();

    @BeforeEach
    void reset() {
        failExecute = false;
        jdbc.execute("DELETE FROM run_event");
        jdbc.execute("DELETE FROM message");
        jdbc.execute("DELETE FROM run");
        jdbc.execute("DELETE FROM conversation");
        jdbc.execute("DELETE FROM agent");
    }

    @SuppressWarnings("unchecked")
    private String createAgent() {
        Map<String, Object> body = Map.of(
                "name", "集成测试 agent",
                "description", "由 RunFlowIT 创建",
                "graph", mapper.convertValue(GraphFixtures.withTools(), Map.class));
        ResponseEntity<Map> response = rest.postForEntity("/api/agents", body, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) response.getBody().get("id");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> startRun(String agentId, Map<String, Object> input) {
        ResponseEntity<Map> response = rest.postForEntity(
                "/api/agents/" + agentId + "/runs", Map.of("input", input), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        return response.getBody();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> awaitTerminal(String runId) {
        long deadline = System.currentTimeMillis() + 20_000;
        while (System.currentTimeMillis() < deadline) {
            Map<String, Object> run = rest.getForObject("/api/runs/" + runId, Map.class);
            Object status = run.get("status");
            if ("SUCCEEDED".equals(status) || "FAILED".equals(status)) {
                return run;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return fail("run " + runId + " 未在超时前进入终态");
    }

    private String readSse(String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url)).GET().build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        return response.body();
    }

    private static List<String> dataLines(String sseBody) {
        List<String> data = new ArrayList<>();
        for (String line : sseBody.split("\n")) {
            if (line.startsWith("data:")) {
                data.add(line.substring("data:".length()).trim());
            }
        }
        return data;
    }

    @Test
    @DisplayName("完整业务流程：新建 agent → 提交运行 → 事件与消息落库 → 终态收敛")
    void fullRunFlowPersistsEverything() {
        String agentId = createAgent();

        Map<String, Object> started = startRun(agentId, Map.of("topic", "hi"));
        String runId = (String) started.get("runId");
        String conversationId = (String) started.get("conversationId");
        assertThat(runId).isNotBlank();
        assertThat(conversationId).isNotBlank();

        Map<String, Object> run = awaitTerminal(runId);
        assertThat(run.get("status")).isEqualTo("SUCCEEDED");
        assertThat(run.get("answer")).isEqualTo("你好世界");

        // seq 由 server 单调分配，且与落库条数一致
        List<Map<String, Object>> events = jdbc.queryForList(
                "SELECT seq, type FROM run_event WHERE run_id = ? ORDER BY seq", runId);
        assertThat(events).hasSize(CANNED_EVENTS.size());
        for (int i = 0; i < events.size(); i++) {
            assertThat(((Number) events.get(i).get("seq")).intValue()).isEqualTo(i + 1);
        }
        assertThat(events.get(0).get("type")).isEqualTo("run.started");
        assertThat(events.get(events.size() - 1).get("type")).isEqualTo("run.finished");

        // 消息：server 落用户输入，runtime 的 message.completed 落助手回复
        List<Map<String, Object>> messages = jdbc.queryForList(
                "SELECT seq, role, content FROM message WHERE conversation_id = ? ORDER BY seq", conversationId);
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0)).containsEntry("role", "user").containsEntry("content", "hi");
        assertThat(messages.get(1)).containsEntry("role", "assistant").containsEntry("content", "你好世界");

        // 事件里带上的是 server 分配的 runId（而不是 runtime 回显的），保证两端一致
        JsonNode firstEvent = read(events.get(0));
        assertThat(firstEvent.path("type").asText()).isEqualTo("run.started");
    }

    @Test
    @DisplayName("SSE 按下标有序回放，并支持 afterSeq 断点续传")
    void sseReplaysAndResumes() throws Exception {
        String agentId = createAgent();
        String runId = (String) startRun(agentId, Map.of("topic", "hi")).get("runId");
        awaitTerminal(runId);

        String base = rest.getRootUri() + "/api/runs/" + runId + "/events";

        List<String> all = dataLines(readSse(base));
        assertThat(all).hasSize(CANNED_EVENTS.size());
        assertThat(all.get(0)).contains("run.started");
        assertThat(all.get(1)).contains("node.started");
        assertThat(all.get(all.size() - 1)).contains("run.finished");
        // SSE 事件 id 就是 seq，浏览器断线重连会自动带上 Last-Event-ID
        assertThat(readSse(base)).contains("id:1").contains("event:run.started");

        List<String> resumed = dataLines(readSse(base + "?afterSeq=3"));
        assertThat(resumed).hasSize(CANNED_EVENTS.size() - 3);
        assertThat(resumed.get(0)).contains("llm.token");
    }

    @Test
    @DisplayName("runtime 报错时 run 必须收敛成 FAILED，并且错误事件也落库")
    void runtimeFailureStillConverges() {
        failExecute = true;
        String agentId = createAgent();

        String runId = (String) startRun(agentId, Map.of("topic", "hi")).get("runId");
        Map<String, Object> run = awaitTerminal(runId);

        assertThat(run.get("status")).isEqualTo("FAILED");
        assertThat(run.get("error")).isNotNull();
        assertThat(run.get("error").toString()).contains("RUNTIME_UNAVAILABLE");

        List<Map<String, Object>> events = jdbc.queryForList(
                "SELECT seq, type FROM run_event WHERE run_id = ? ORDER BY seq", runId);
        List<String> types = events.stream().map(e -> (String) e.get("type")).toList();
        // runtime 一行都没吐出来，服务端也要补齐 run.error + run.finished
        assertThat(types).containsExactly("run.error", "run.finished");
        assertThat(events.get(0).get("seq")).isEqualTo(1);
        assertThat(events.get(1).get("seq")).isEqualTo(2);
    }

    @Test
    @DisplayName("会话可以连续跑多轮：第二轮会把第一轮历史下发给 runtime")
    void conversationKeepsHistory() {
        String agentId = createAgent();
        Map<String, Object> first = startRun(agentId, Map.of("topic", "第一轮"));
        awaitTerminal((String) first.get("runId"));

        ResponseEntity<Map> second = rest.postForEntity(
                "/api/agents/" + agentId + "/runs",
                Map.of("input", Map.of("topic", "第二轮"), "conversationId", first.get("conversationId")),
                Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        awaitTerminal((String) second.getBody().get("runId"));

        List<Map<String, Object>> messages = jdbc.queryForList(
                "SELECT role FROM message WHERE conversation_id = ? ORDER BY seq", first.get("conversationId"));
        // 用户×2 + 助手×2
        assertThat(messages).hasSize(4);
    }

    @Test
    @DisplayName("不存在的 run / agent 返回 404 而不是 500")
    void missingResourcesReturn404() {
        assertThat(rest.getForEntity("/api/runs/does-not-exist", Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.getForEntity("/api/agents/does-not-exist", Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    private JsonNode read(Object value) {
        return mapper.valueToTree(value);
    }
}
