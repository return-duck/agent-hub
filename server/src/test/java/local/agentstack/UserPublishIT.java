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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 用户体系 + 归属隔离 + 发布分享 + 公开对话的端到端集成测试。
 *
 * 用桩 runtime（与 RunFlowIT 同样的手法），这样公开对话能真正跑到终态，
 * 而不是只断言"202 收下了"。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class UserPublishIT {

    private static final HttpServer STUB;
    private static final int STUB_PORT;

    static {
        try {
            STUB = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            STUB.createContext("/execute", UserPublishIT::handleExecute);
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

    /** 固定脚本，终态必为 SUCCEEDED，回答固定为"你好世界"。 */
    private static final List<String> CANNED_EVENTS = List.of(
            "{\"type\":\"run.started\",\"nodeId\":null,\"payload\":{\"model\":{\"provider\":\"stub\",\"name\":\"stub\",\"mode\":\"scripted\"},\"graphSchemaVersion\":1,\"input\":{}}}",
            "{\"type\":\"llm.token\",\"nodeId\":\"n3\",\"payload\":{\"delta\":\"你好\"}}",
            "{\"type\":\"message.completed\",\"nodeId\":\"n3\",\"payload\":{\"role\":\"assistant\",\"content\":\"你好世界\"}}",
            "{\"type\":\"run.finished\",\"nodeId\":null,\"payload\":{\"status\":\"SUCCEEDED\",\"durationMs\":5,\"answer\":\"你好世界\",\"totals\":{\"inputTokens\":1,\"outputTokens\":1,\"llmCalls\":1,\"toolCalls\":0,\"steps\":1}}}");

    private static void handleExecute(HttpExchange exchange) throws IOException {
        exchange.getRequestBody().readAllBytes();
        exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson; charset=utf-8");
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream out = exchange.getResponseBody()) {
            for (String event : CANNED_EVENTS) {
                out.write((event + "\n").getBytes(StandardCharsets.UTF_8));
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

    @BeforeEach
    void reset() {
        jdbc.execute("DELETE FROM run_event");
        jdbc.execute("DELETE FROM message");
        jdbc.execute("DELETE FROM run");
        jdbc.execute("DELETE FROM conversation");
        jdbc.execute("DELETE FROM agent");
        jdbc.execute("DELETE FROM user_session");
        jdbc.execute("DELETE FROM app_user");
    }

    // ------------------------------------------------------------ 辅助

    private record Session(String token, String userId) {
    }

    @SuppressWarnings("unchecked")
    private Session register(String email, String displayName, String password) {
        Map<String, Object> body = Map.of("email", email, "displayName", displayName, "password", password);
        ResponseEntity<Map> response = rest.postForEntity("/api/auth/register", body, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Map<String, Object> user = (Map<String, Object>) response.getBody().get("user");
        return new Session((String) response.getBody().get("token"), (String) user.get("id"));
    }

    private Session newUser() {
        return register("u-" + UUID.randomUUID() + "@test.local", "测试用户", "password123");
    }

    private HttpHeaders json(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return headers;
    }

    private ResponseEntity<Map> post(String url, String token, Object body) {
        return exchange(HttpMethod.POST, url, token, body);
    }

    private ResponseEntity<Map> get(String url, String token) {
        return exchange(HttpMethod.GET, url, token, null);
    }

    /** 列表接口：TestRestTemplate 的泛型在原始 Map 上推断不出来，单独走一个 raw List 版本。 */
    @SuppressWarnings({"rawtypes", "unchecked"})
    private List<Map<String, Object>> getList(String url, String token) {
        ResponseEntity<List> response = rest.exchange(url, HttpMethod.GET, new HttpEntity<>(json(token)), List.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) (List) response.getBody();
    }

    /** 公开对话请求体：conversationId 允许为空（表示新开会话），Map.of 不支持 null 值。 */
    private Map<String, Object> publicRunBody(Map<String, Object> input, String conversationId, String visitorId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("input", input);
        body.put("conversationId", conversationId);
        body.put("visitorId", visitorId);
        return body;
    }

    /** Map.of 不接受 null 值，而 description 允许为空，所以用可变 Map。 */
    private Map<String, Object> agentBody(String name, String description, Object graph) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("description", description);
        body.put("graph", graph);
        return body;
    }

    /**
     * SSE 端点要带 Accept: text/event-stream —— 浏览器的 EventSource 就是这么发的。
     * 不带的话会在 handler 映射阶段就被拒（produces 不兼容），测不到鉴权逻辑。
     */
    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> getSse(String url, String token) {
        HttpHeaders headers = json(token);
        headers.setAccept(List.of(MediaType.TEXT_EVENT_STREAM));
        return rest.exchange(url, HttpMethod.GET, new HttpEntity<>(headers), Map.class);
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> exchange(HttpMethod method, String url, String token, Object body) {
        return rest.exchange(url, method, new HttpEntity<>(body, json(token)), Map.class);
    }

    @SuppressWarnings("unchecked")
    private String createAgent(String token) {
        Map<String, Object> body = agentBody("agent-" + UUID.randomUUID(), "归属与发布测试",
                mapper.convertValue(GraphFixtures.withTools(), Map.class));
        ResponseEntity<Map> response = post("/api/agents", token, body);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) response.getBody().get("id");
    }

    @SuppressWarnings("unchecked")
    private String publish(String token, String agentId) {
        ResponseEntity<Map> response = post("/api/agents/" + agentId + "/publish", token, null);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) response.getBody().get("slug");
    }

    /** 轮询公开会话的历史，直到出现 assistant 消息（桩 runtime 是同步吐完的）。 */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> awaitPublicMessages(String slug, String visitorId, String conversationId) {
        long deadline = System.currentTimeMillis() + 20_000;
        List<Map<String, Object>> messages = List.of();
        while (System.currentTimeMillis() < deadline) {
            ResponseEntity<List> response = rest.exchange(
                    "/api/public/agents/" + slug + "/conversations/" + conversationId
                            + "/messages?visitorId=" + visitorId,
                    HttpMethod.GET, new HttpEntity<>(json(null)), List.class);
            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
            messages = response.getBody();
            if (messages.stream().anyMatch(m -> "assistant".equals(m.get("role")))) {
                return messages;
            }
            sleep(50);
        }
        return messages;
    }

    /** 主人侧的会话消息也要等助手这条异步落库。 */
    private List<Map<String, Object>> awaitConversationMessages(String token, String conversationId, int expected) {
        long deadline = System.currentTimeMillis() + 20_000;
        List<Map<String, Object>> messages = List.of();
        while (System.currentTimeMillis() < deadline) {
            messages = getList("/api/conversations/" + conversationId + "/messages", token);
            if (messages.size() >= expected) {
                return messages;
            }
            sleep(50);
        }
        return messages;
    }

    /** 轮询 run 到终态，用于"等上一轮答完再发下一轮"。 */
    private Map<String, Object> awaitRunTerminal(String token, String runId) {
        long deadline = System.currentTimeMillis() + 20_000;
        Map<String, Object> run = Map.of();
        while (System.currentTimeMillis() < deadline) {
            run = get("/api/runs/" + runId, token).getBody();
            Object status = run.get("status");
            if ("SUCCEEDED".equals(status) || "FAILED".equals(status)) {
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

    // ------------------------------------------------------------ 注册 / 登录

    @Test
    @DisplayName("注册校验：密码过短 400，邮箱重复 409")
    void registerValidation() {
        assertThat(post("/api/auth/register", null,
                Map.of("email", "a@test.local", "displayName", "甲", "password", "short")).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        String email = "dup-" + UUID.randomUUID() + "@test.local";
        register(email, "乙", "password123");
        assertThat(post("/api/auth/register", null,
                Map.of("email", email, "displayName", "丙", "password", "password123")).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    @DisplayName("登录成功后 /me 返回当前用户；密码错误返回 401 且不泄露账号是否存在")
    void loginAndMe() {
        String email = "login-" + UUID.randomUUID() + "@test.local";
        register(email, "登录用户", "password123");

        ResponseEntity<Map> ok = post("/api/auth/login", null, Map.of("email", email, "password", "password123"));
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        String token = (String) ok.getBody().get("token");

        ResponseEntity<Map> me = get("/api/auth/me", token);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(me.getBody()).containsEntry("email", email);

        assertThat(post("/api/auth/login", null, Map.of("email", email, "password", "wrong-password"))
                .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(post("/api/auth/login", null, Map.of("email", "nobody@test.local", "password", "password123"))
                .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("登出后令牌立即失效；无令牌访问受保护接口返回 401")
    void logoutAndAnonymousAccess() {
        Session session = newUser();
        assertThat(getList("/api/agents", session.token())).isEmpty();

        assertThat(post("/api/auth/logout", session.token(), null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(get("/api/auth/me", session.token()).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        assertThat(get("/api/agents", null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(post("/api/agents", null,
                agentBody("x", null, mapper.convertValue(GraphFixtures.minimal(), Map.class))).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ------------------------------------------------------------ 归属隔离

    @Test
    @DisplayName("agent 按用户隔离：别人的 agent 一律当作不存在（404 而不是 403）")
    void agentsAreIsolatedBetweenUsers() {
        Session alice = newUser();
        Session bob = newUser();
        String aliceAgent = createAgent(alice.token());

        assertThat(getList("/api/agents", alice.token())).hasSize(1);
        assertThat(getList("/api/agents", bob.token())).isEmpty();

        assertThat(get("/api/agents/" + aliceAgent, bob.token()).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(exchange(HttpMethod.DELETE, "/api/agents/" + aliceAgent, bob.token(), null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/agents/" + aliceAgent + "/publish", bob.token(), null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/agents/" + aliceAgent + "/runs", bob.token(), Map.of("input", Map.of("topic", "hi")))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("不同用户可以各自拥有同名 agent（唯一约束已改为按归属）")
    void sameAgentNameAllowedForDifferentOwners() {
        Session alice = newUser();
        Session bob = newUser();
        String name = "同名 agent " + UUID.randomUUID();
        Map<String, Object> body = agentBody(name, null, mapper.convertValue(GraphFixtures.withTools(), Map.class));

        assertThat(post("/api/agents", alice.token(), body).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(post("/api/agents", bob.token(), body).getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    // ------------------------------------------------------------ 发布与公开对话

    @Test
    @DisplayName("发布后公开可访问（免登录），访客能对话并拿到历史；取消发布后立即不可访问")
    void publishThenChatThenUnpublish() {
        Session owner = newUser();
        String agentId = createAgent(owner.token());
        String slug = publish(owner.token(), agentId);
        assertThat(slug).isNotBlank();

        // 公开信息：免登录可读，且不泄露 graph
        ResponseEntity<Map> info = get("/api/public/agents/" + slug, null);
        assertThat(info.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(info.getBody()).containsKeys("slug", "name", "description");
        assertThat(info.getBody()).doesNotContainKey("graph");

        String visitorId = UUID.randomUUID().toString();
        ResponseEntity<Map> started = post("/api/public/agents/" + slug + "/runs", null,
                publicRunBody(Map.of("topic", "你好"), null, visitorId));
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        String conversationId = (String) started.getBody().get("conversationId");

        List<Map<String, Object>> messages = awaitPublicMessages(slug, visitorId, conversationId);
        assertThat(messages).anyMatch(m -> "user".equals(m.get("role")));
        assertThat(messages).anyMatch(m -> "assistant".equals(m.get("role"))
                && "你好世界".equals(m.get("content")));

        // 取消发布后，公开入口立即 404
        assertThat(post("/api/agents/" + agentId + "/unpublish", owner.token(), null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(get("/api/public/agents/" + slug, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/public/agents/" + slug + "/runs", null,
                publicRunBody(Map.of("topic", "hi"), null, visitorId))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("未发布的 agent 即使猜到 slug 也无法访问")
    void unpublishedAgentIsNotPublic() {
        Session owner = newUser();
        createAgent(owner.token());
        // 未发布时 public_slug 为 NULL，任意 slug 都取不到
        assertThat(get("/api/public/agents/" + UUID.randomUUID().toString().substring(0, 12), null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("访客之间互相隔离：拿别人的 conversationId 读不到历史，也开不了 SSE")
    void visitorsAreIsolated() {
        Session owner = newUser();
        String agentId = createAgent(owner.token());
        String slug = publish(owner.token(), agentId);

        String visitor1 = UUID.randomUUID().toString();
        String visitor2 = UUID.randomUUID().toString();

        ResponseEntity<Map> started = post("/api/public/agents/" + slug + "/runs", null,
                publicRunBody(Map.of("topic", "机密"), null, visitor1));
        String conversationId = (String) started.getBody().get("conversationId");
        String runId = (String) started.getBody().get("runId");

        // 访客 2 用访客 1 的 conversationId 读历史 → 404
        assertThat(get("/api/public/agents/" + slug + "/conversations/" + conversationId
                + "/messages?visitorId=" + visitor2, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // 访客 2 用访客 1 的 runId 开 SSE → 404
        assertThat(getSse("/api/public/agents/" + slug + "/runs/" + runId + "/events?visitorId=" + visitor2, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // 访客 2 的会话列表里没有访客 1 的会话
        assertThat(getList("/api/public/agents/" + slug + "/conversations?visitorId=" + visitor2, null)).isEmpty();
        // 访客 1 自己能读到（并且能看到自己的会话）
        assertThat(getList("/api/public/agents/" + slug + "/conversations?visitorId=" + visitor1, null)).hasSize(1);
    }

    // ------------------------------------------------------------ 会话列表

    @Test
    @DisplayName("每个 agent 有自己的会话列表，且能区分访客会话与工作室会话")
    void agentHasOwnConversationList() {
        Session owner = newUser();
        String agentId = createAgent(owner.token());
        String slug = publish(owner.token(), agentId);

        // 1) 工作室里开一个会话
        assertThat(post("/api/agents/" + agentId + "/runs", owner.token(), Map.of("input", Map.of("topic", "工作室")))
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        // 2) 公开页面开一个会话
        String visitorId = UUID.randomUUID().toString();
        assertThat(post("/api/public/agents/" + slug + "/runs", null,
                publicRunBody(Map.of("topic", "访客"), null, visitorId))
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        List<Map<String, Object>> conversations = getList("/api/agents/" + agentId + "/conversations", owner.token());
        assertThat(conversations).hasSize(2);
        assertThat(conversations).anyMatch(c -> Boolean.TRUE.equals(c.get("fromVisitor")));
        assertThat(conversations).anyMatch(c -> Boolean.FALSE.equals(c.get("fromVisitor")));
        // 每个会话都带上了消息数
        assertThat(conversations).allMatch(c -> ((Number) c.get("messageCount")).intValue() >= 1);

        // 别人的会话列表不可见
        Session other = newUser();
        assertThat(get("/api/agents/" + agentId + "/conversations", other.token()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("同一会话上一轮没结束时，第二轮被拒绝（409），避免 seq 撞车与回答交叉")
    void concurrentTurnOnSameConversationIsRejected() {
        Session owner = newUser();
        String agentId = createAgent(owner.token());

        @SuppressWarnings("unchecked")
        Map<String, Object> first = post("/api/agents/" + agentId + "/runs", owner.token(),
                Map.of("input", Map.of("topic", "第一条", "delayMs", 1500))).getBody();
        String conversationId = (String) first.get("conversationId");

        ResponseEntity<Map> second = post("/api/agents/" + agentId + "/runs", owner.token(),
                Map.of("input", Map.of("topic", "抢跑的第二条"), "conversationId", conversationId));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // 等第一轮结束后再发，就应该成功
        awaitRunTerminal(owner.token(), (String) first.get("runId"));
        assertThat(post("/api/agents/" + agentId + "/runs", owner.token(),
                Map.of("input", Map.of("topic", "正常第二条"), "conversationId", conversationId)).getStatusCode())
                .isEqualTo(HttpStatus.ACCEPTED);
    }

    @Test
    @DisplayName("会话可以续聊：带上 conversationId 时不会新建会话，历史累加")
    void conversationContinuesWithHistory() {
        Session owner = newUser();
        String agentId = createAgent(owner.token());

        @SuppressWarnings("unchecked")
        Map<String, Object> first = post("/api/agents/" + agentId + "/runs", owner.token(),
                Map.of("input", Map.of("topic", "第一句"))).getBody();
        String conversationId = (String) first.get("conversationId");
        awaitRunTerminal(owner.token(), (String) first.get("runId"));

        ResponseEntity<Map> second = post("/api/agents/" + agentId + "/runs", owner.token(),
                Map.of("input", Map.of("topic", "第二句"), "conversationId", conversationId));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        List<Map<String, Object>> messages = awaitConversationMessages(owner.token(), conversationId, 4);
        assertThat(messages).hasSize(4); // 两轮 × (user + assistant)
        assertThat(messages.get(0)).containsEntry("role", "user").containsEntry("content", "第一句");
        assertThat(messages.get(2)).containsEntry("role", "user").containsEntry("content", "第二句");

        assertThat(getList("/api/agents/" + agentId + "/conversations", owner.token())).hasSize(1);
    }
}
