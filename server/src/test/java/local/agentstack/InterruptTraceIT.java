package local.agentstack;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 中断对话 / 断点重试 / 调用轨迹（持久化）的端到端集成测试。
 *
 * 用可控的桩 runtime：可以放慢事件节奏（给"中断"留出时间窗），
 * 并记录"客户端是否断开了连接" —— 这是"点暂停真的让 LLM 侧停下来"的直接证据。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class InterruptTraceIT {

    private static final HttpServer STUB;
    private static final int STUB_PORT;

    /** 每条事件之间的间隔；调大就得到"跑得很慢的 run"，便于中断。 */
    private static volatile int eventDelayMs = 0;
    /** 客户端断开连接的次数（含因中断而断开）。 */
    private static final AtomicInteger DISCONNECTS = new AtomicInteger();
    /** 是否让 runtime 直接返回失败（用于验证重试）。 */
    private static volatile boolean failExecute = false;

    static {
        try {
            STUB = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            STUB.createContext("/execute", InterruptTraceIT::handleExecute);
            STUB.start();
            STUB_PORT = STUB.getAddress().getPort();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void runtimeProperties(DynamicPropertyRegistry registry) {
        registry.add("app.runtime.base-url", () -> "http://127.0.0.1:" + STUB_PORT);
        registry.add("app.runtime.execute-timeout-ms", () -> 30_000);
    }

    /** 一段包含"模型两次调用 + 一次工具调用 + 四个节点"的完整脚本。 */
    private static List<String> cannedEvents() {
        return List.of(
                "{\"type\":\"run.started\",\"nodeId\":null,\"payload\":{\"model\":{\"provider\":\"stub\",\"name\":\"stub-model\",\"mode\":\"live\"},\"graphSchemaVersion\":1,\"input\":{\"topic\":\"hi\"}}}",
                "{\"type\":\"node.started\",\"nodeId\":\"n1\",\"payload\":{\"nodeType\":\"start\",\"label\":\"开始\"}}",
                "{\"type\":\"node.finished\",\"nodeId\":\"n1\",\"payload\":{\"nodeType\":\"start\",\"durationMs\":1,\"status\":\"ok\"}}",
                "{\"type\":\"node.started\",\"nodeId\":\"n3\",\"payload\":{\"nodeType\":\"llm\",\"label\":\"大模型\"}}",
                "{\"type\":\"llm.completed\",\"nodeId\":\"n3\",\"payload\":{\"model\":\"stub/stub-model\",\"inputTokens\":11,\"outputTokens\":2,\"messageCount\":1,\"durationMs\":8,\"estimated\":false,"
                        + "\"input\":\"[user] (12+8)*3\",\"output\":\"\"}}",
                "{\"type\":\"tool.started\",\"nodeId\":\"n3\",\"payload\":{\"toolName\":\"calculator\",\"callId\":\"call-1\",\"kind\":\"tool\",\"args\":{\"expression\":\"(12+8)*3\"}}}",
                "{\"type\":\"tool.finished\",\"nodeId\":\"n3\",\"payload\":{\"toolName\":\"calculator\",\"callId\":\"call-1\",\"kind\":\"tool\",\"durationMs\":2,\"result\":\"(12+8)*3 = 60\",\"isError\":false,\"truncated\":false}}",
                "{\"type\":\"llm.completed\",\"nodeId\":\"n3\",\"payload\":{\"model\":\"stub/stub-model\",\"inputTokens\":8,\"outputTokens\":5,\"messageCount\":3,\"durationMs\":6,\"estimated\":false,"
                        + "\"input\":\"[user] (12+8)*3\\n\\n[tool] (12+8)*3 = 60\",\"output\":\"等于 60\"}}",
                "{\"type\":\"message.completed\",\"nodeId\":\"n3\",\"payload\":{\"role\":\"assistant\",\"content\":\"等于 60\"}}",
                "{\"type\":\"node.finished\",\"nodeId\":\"n3\",\"payload\":{\"nodeType\":\"llm\",\"durationMs\":20,\"status\":\"ok\"}}",
                "{\"type\":\"run.finished\",\"nodeId\":null,\"payload\":{\"status\":\"SUCCEEDED\",\"durationMs\":40,\"answer\":\"等于 60\",\"totals\":{\"inputTokens\":19,\"outputTokens\":7,\"llmCalls\":2,\"toolCalls\":1,\"steps\":2}}}");
    }

    private static void handleExecute(HttpExchange exchange) throws IOException {
        exchange.getRequestBody().readAllBytes();
        exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson; charset=utf-8");

        if (failExecute) {
            byte[] body = "{\"code\":\"BOOM\",\"message\":\"runtime 内部错误\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(500, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
            return;
        }

        exchange.sendResponseHeaders(200, 0);
        try (OutputStream out = exchange.getResponseBody()) {
            for (String event : cannedEvents()) {
                out.write((event + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
                if (eventDelayMs > 0) {
                    Thread.sleep(eventDelayMs);
                }
            }
        } catch (IOException | InterruptedException e) {
            // 客户端断开（被中断）会走到这里 —— 这正是"暂停真的传到了 LLM 侧"的证据
            DISCONNECTS.incrementAndGet();
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
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

    @BeforeEach
    void reset() {
        failExecute = false;
        eventDelayMs = 0;
        DISCONNECTS.set(0);
        jdbc.execute("DELETE FROM trace_span");
        jdbc.execute("DELETE FROM run_event");
        jdbc.execute("DELETE FROM message");
        jdbc.execute("DELETE FROM run");
        jdbc.execute("DELETE FROM conversation");
        jdbc.execute("DELETE FROM agent");
        jdbc.execute("DELETE FROM user_session");
        jdbc.execute("DELETE FROM app_user");
    }

    // ------------------------------------------------------------ 辅助

    private record Session(String token) {
    }

    @SuppressWarnings("unchecked")
    private Session newUser() {
        Map<String, Object> body = Map.of("email", "u-" + UUID.randomUUID() + "@test.local",
                "displayName", "中断测试", "password", "password123");
        ResponseEntity<Map> response = rest.postForEntity("/api/auth/register", body, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return new Session((String) response.getBody().get("token"));
    }

    private HttpHeaders json(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return headers;
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> post(String url, String token, Object body) {
        return rest.exchange(url, HttpMethod.POST, new HttpEntity<>(body, json(token)), Map.class);
    }

    /** 回退接口返回的是消息列表，不能按 Map 反序列化 */
    @SuppressWarnings({"rawtypes", "unchecked"})
    private List<Map<String, Object>> postList(String url, String token, Object body) {
        ResponseEntity<List> response = rest.exchange(url, HttpMethod.POST, new HttpEntity<>(body, json(token)),
                List.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) (List) response.getBody();
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> get(String url, String token) {
        return rest.exchange(url, HttpMethod.GET, new HttpEntity<>(json(token)), Map.class);
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private List<Map<String, Object>> getList(String url, String token) {
        ResponseEntity<List> response = rest.exchange(url, HttpMethod.GET, new HttpEntity<>(json(token)), List.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) (List) response.getBody();
    }

    @SuppressWarnings("unchecked")
    private String createAgent(String token) {
        Map<String, Object> body = Map.of("name", "agent-" + UUID.randomUUID(), "description", "断点重试测试",
                "graph", mapper.convertValue(GraphFixtures.withTools(), Map.class));
        ResponseEntity<Map> response = post("/api/agents", token, body);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) response.getBody().get("id");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> startRun(String token, String agentId, Map<String, Object> input, String conversationId) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("input", input);
        body.put("conversationId", conversationId);
        ResponseEntity<Map> response = post("/api/agents/" + agentId + "/runs", token, body);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        return response.getBody();
    }

    private Map<String, Object> awaitStatus(String token, String runId, String expected, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        Map<String, Object> run = Map.of();
        while (System.currentTimeMillis() < deadline) {
            run = get("/api/runs/" + runId, token).getBody();
            if (expected.equals(run.get("status"))) {
                return run;
            }
            sleep(50);
        }
        return run;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ------------------------------------------------------------ 1. 中断

    @Test
    @DisplayName("中断：点暂停后 run 收敛为 CANCELLED，且 runtime 侧连接被真的掐断")
    void cancelStopsTheRunAndDisconnectsRuntime() {
        Session user = newUser();
        String agentId = createAgent(user.token());

        // 放慢事件节奏，留出中断的时间窗
        eventDelayMs = 120;
        Map<String, Object> started = startRun(user.token(), agentId, Map.of("topic", "慢跑"), null);
        String runId = (String) started.get("runId");

        // 等它真的跑起来（至少产生了事件）
        Map<String, Object> running = awaitStatus(user.token(), runId, "RUNNING", 5_000);
        assertThat(running.get("status")).isEqualTo("RUNNING");

        ResponseEntity<Map> cancelled = post("/api/runs/" + runId + "/cancel", user.token(), null);
        assertThat(cancelled.getStatusCode()).isEqualTo(HttpStatus.OK);

        Map<String, Object> terminal = awaitStatus(user.token(), runId, "CANCELLED", 10_000);
        assertThat(terminal.get("status")).as("中断后必须收敛到 CANCELLED").isEqualTo("CANCELLED");

        // 被中断的 run 不应该留下 run.error（中断不是错误）
        Integer errorEvents = jdbc.queryForObject(
                "SELECT COUNT(*) FROM run_event WHERE run_id = ? AND type = 'run.error'", Integer.class, runId);
        assertThat(errorEvents).isZero();

        // 终态事件必须带上 CANCELLED，前端据此收口
        String finishedPayload = jdbc.queryForObject(
                "SELECT payload_json FROM run_event WHERE run_id = ? AND type = 'run.finished'", String.class, runId);
        assertThat(finishedPayload).contains("CANCELLED");

        // 关键证据：Java 关掉事件流后，桩 runtime 应该在下一次写入时观测到客户端断开。
        // 这是个异步副作用（要等桩再写一次才知道），所以轮询等待而不是立刻断言。
        long deadline = System.currentTimeMillis() + 5_000;
        while (DISCONNECTS.get() == 0 && System.currentTimeMillis() < deadline) {
            sleep(50);
        }
        assertThat(DISCONNECTS.get())
                .as("中断必须传导到 runtime：Java 关掉事件流后，桩的写入应当失败")
                .isGreaterThan(0);
    }

    @Test
    @DisplayName("中断是幂等的：对已经结束的 run 调用 cancel 也返回正常状态")
    void cancelIsIdempotent() {
        Session user = newUser();
        String agentId = createAgent(user.token());
        Map<String, Object> started = startRun(user.token(), agentId, Map.of("topic", "跑完"), null);
        String runId = (String) started.get("runId");
        awaitStatus(user.token(), runId, "SUCCEEDED", 10_000);

        ResponseEntity<Map> again = post("/api/runs/" + runId + "/cancel", user.token(), null);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody().get("status")).isEqualTo("SUCCEEDED");
    }

    // ------------------------------------------------------------ 2. 回退 / 重试

    @Test
    @DisplayName("回退：删掉指定 seq 之后的消息与其 run（含轨迹），历史回到该点")
    void rewindTruncatesConversationAndRuns() {
        Session user = newUser();
        String agentId = createAgent(user.token());

        Map<String, Object> first = startRun(user.token(), agentId, Map.of("topic", "第一句"), null);
        String conversationId = (String) first.get("conversationId");
        awaitStatus(user.token(), (String) first.get("runId"), "SUCCEEDED", 10_000);

        Map<String, Object> second = startRun(user.token(), agentId, Map.of("topic", "第二句"), conversationId);
        awaitStatus(user.token(), (String) second.get("runId"), "SUCCEEDED", 10_000);
        assertThat(getList("/api/conversations/" + conversationId + "/messages", user.token())).hasSize(4);

        // 退回到第一轮结束（保留 seq 1、2），第二轮整体消失
        List<Map<String, Object>> rewound = postList("/api/conversations/" + conversationId + "/rewind",
                user.token(), Map.of("keepSeq", 2));
        assertThat(rewound).hasSize(2);

        List<Map<String, Object>> messages = getList("/api/conversations/" + conversationId + "/messages",
                user.token());
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0)).containsEntry("content", "第一句");

        // run 与轨迹一起被清掉，不留孤儿
        Integer remainingRuns = jdbc.queryForObject(
                "SELECT COUNT(*) FROM run WHERE conversation_id = ?", Integer.class, conversationId);
        assertThat(remainingRuns).isEqualTo(1);
        Integer orphanSpans = jdbc.queryForObject(
                "SELECT COUNT(*) FROM trace_span WHERE conversation_id = ? AND run_id NOT IN"
                        + " (SELECT id FROM run)", Integer.class, conversationId);
        assertThat(orphanSpans).as("回退删 run 时轨迹必须级联删除").isZero();
    }

    @Test
    @DisplayName("断点重试：回退这一轮后用同样的输入重跑，并记录重试血缘")
    void retryRerunsFromTheSameInput() {
        Session user = newUser();
        String agentId = createAgent(user.token());

        Map<String, Object> first = startRun(user.token(), agentId, Map.of("topic", "要重试的这句话"), null);
        String conversationId = (String) first.get("conversationId");
        String firstRunId = (String) first.get("runId");
        awaitStatus(user.token(), firstRunId, "SUCCEEDED", 10_000);

        ResponseEntity<Map> retried = post("/api/runs/" + firstRunId + "/retry", user.token(), null);
        assertThat(retried.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        String retryRunId = (String) retried.getBody().get("runId");
        assertThat(retryRunId).isNotEqualTo(firstRunId);

        Map<String, Object> terminal = awaitStatus(user.token(), retryRunId, "SUCCEEDED", 10_000);
        assertThat(terminal.get("conversationId")).isEqualTo(conversationId);

        // 血缘：新 run 指向被重试的那个
        String retryOf = jdbc.queryForObject(
                "SELECT retry_of_run_id FROM run WHERE id = ?", String.class, retryRunId);
        assertThat(retryOf).isEqualTo(firstRunId);

        // 输入必须一模一样，且历史里那段半截输出已被回退
        String input = jdbc.queryForObject("SELECT input_json FROM run WHERE id = ?", String.class, retryRunId);
        assertThat(input).contains("要重试的这句话");
        List<Map<String, Object>> messages = getList("/api/conversations/" + conversationId + "/messages",
                user.token());
        assertThat(messages.stream().filter(m -> "user".equals(m.get("role"))).count())
                .as("重试后这一轮的 user 消息只有一条").isEqualTo(1);
    }

    // ------------------------------------------------------------ 3. 调用轨迹

    @Test
    @DisplayName("轨迹：模型输入输出、工具调用、节点都持久化，并能按 run / 会话 / agent 查到")
    void tracesArePersistedAndQueryable() {
        Session user = newUser();
        String agentId = createAgent(user.token());
        Map<String, Object> started = startRun(user.token(), agentId, Map.of("topic", "(12+8)*3"), null);
        String runId = (String) started.get("runId");
        String conversationId = (String) started.get("conversationId");
        awaitStatus(user.token(), runId, "SUCCEEDED", 10_000);

        List<Map<String, Object>> spans = getList("/api/runs/" + runId + "/traces", user.token());
        assertThat(spans).isNotEmpty();

        // 类别齐全：节点 / 模型 / 工具
        List<String> kinds = spans.stream().map(s -> (String) s.get("kind")).toList();
        assertThat(kinds).contains("node", "model", "tool");

        // 模型 span 必须记录输入与输出
        Map<String, Object> modelSpan = spans.stream()
                .filter(s -> "model".equals(s.get("kind"))).findFirst().orElseThrow();
        assertThat(modelSpan.get("input").toString()).contains("(12+8)*3");
        assertThat(modelSpan.get("attributes").toString()).contains("inputTokens");

        // 工具有参数与结果，且带类别（将来 MCP / 技能会复用同一字段）
        Map<String, Object> toolSpan = spans.stream()
                .filter(s -> "tool".equals(s.get("kind"))).findFirst().orElseThrow();
        assertThat(toolSpan.get("name")).isEqualTo("calculator");
        assertThat(toolSpan.get("input").toString()).contains("(12+8)*3");
        assertThat(toolSpan.get("output").toString()).contains("60");

        // span_seq 单调，保证时间线可还原
        List<Integer> seqs = spans.stream().map(s -> ((Number) s.get("spanSeq")).intValue()).toList();
        assertThat(seqs).isSorted();

        // 另外两条查询路径
        assertThat(getList("/api/conversations/" + conversationId + "/traces", user.token())).isNotEmpty();
        List<Map<String, Object>> runs = getList("/api/agents/" + agentId + "/runs?limit=10", user.token());
        assertThat(runs).hasSize(1);
        assertThat(((Number) runs.get(0).get("spanCount")).intValue()).isEqualTo(spans.size());
    }

    @Test
    @DisplayName("轨迹的归属隔离：别人的 run 轨迹读不到，也中断不了")
    void tracesAndCancelAreIsolated() {
        Session owner = newUser();
        Session other = newUser();
        String agentId = createAgent(owner.token());
        Map<String, Object> started = startRun(owner.token(), agentId, Map.of("topic", "私有"), null);
        String runId = (String) started.get("runId");
        awaitStatus(owner.token(), runId, "SUCCEEDED", 10_000);

        assertThat(get("/api/runs/" + runId + "/traces", other.token()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/runs/" + runId + "/cancel", other.token(), null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/runs/" + runId + "/retry", other.token(), null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/agents/" + agentId + "/runs", other.token()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("runtime 失败时轨迹仍然落库（失败现场也要能复盘）")
    void traceSurvivesRuntimeFailure() {
        Session user = newUser();
        String agentId = createAgent(user.token());
        failExecute = true;
        Map<String, Object> started = startRun(user.token(), agentId, Map.of("topic", "必失败"), null);
        String runId = (String) started.get("runId");

        awaitStatus(user.token(), runId, "FAILED", 10_000);
        // 失败路径下没有 llm/tool 事件，但 run 仍然存在，轨迹查询不该 500
        assertThat(getList("/api/runs/" + runId + "/traces", user.token())).isEmpty();
    }
}
