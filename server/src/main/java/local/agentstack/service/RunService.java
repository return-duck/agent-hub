package local.agentstack.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.api.ApiException;
import local.agentstack.api.dto.ConversationDtos;
import local.agentstack.api.dto.RunDtos;
import local.agentstack.domain.Agent;
import local.agentstack.domain.Conversation;
import local.agentstack.domain.Message;
import local.agentstack.domain.Run;
import local.agentstack.domain.RunStatus;
import local.agentstack.domain.Timestamps;
import local.agentstack.repo.ConversationRepository;
import local.agentstack.repo.MessageRepository;
import local.agentstack.repo.RunRepository;
import local.agentstack.run.RunOrchestrator;
import local.agentstack.run.RuntimeClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 会话与运行。
 *
 * 两条入口刻意分开，而不是加个 boolean 开关：
 *   startForOwner  —— 工作室里，会话属于 agent 的主人
 *   startPublic    —— 公开分享页，会话按 visitorId 隔离
 * 分开写的好处是"访客绝不能读到别人的会话"这条规则可以逐方法写死，
 * 不会因为某个分支忘了判断而漏掉。
 *
 * 会话历史在每次运行前从 MySQL 全量读出并下发给 runtime，
 * 因此 runtime 完全无状态：重启或多副本都不会丢上下文。
 */
@Service
public class RunService {

    private static final int VISITOR_ID_MAX_LENGTH = 64;

    /** 未结束的轮次状态。同一会话上同时只允许一轮，避免 seq 撞车与回答交叉。 */
    private static final List<RunStatus> ACTIVE_STATUSES = List.of(RunStatus.QUEUED, RunStatus.RUNNING);

    private final AgentService agentService;
    private final ConversationRepository conversationRepo;
    private final MessageRepository messageRepo;
    private final RunRepository runRepo;
    private final RunOrchestrator orchestrator;
    private final ObjectMapper mapper;

    public RunService(AgentService agentService,
                      ConversationRepository conversationRepo, MessageRepository messageRepo,
                      RunRepository runRepo, RunOrchestrator orchestrator, ObjectMapper mapper) {
        this.agentService = agentService;
        this.conversationRepo = conversationRepo;
        this.messageRepo = messageRepo;
        this.runRepo = runRepo;
        this.orchestrator = orchestrator;
        this.mapper = mapper;
    }

    // ---------------------------------------------------------------- 发起运行

    @Transactional
    public RunDtos.StartResponse startForOwner(String ownerId, String agentId, RunDtos.StartRequest request) {
        Agent agent = agentService.require(agentId, ownerId);
        return startInternal(agent, request, null);
    }

    @Transactional
    public RunDtos.StartResponse startPublic(String slug, String visitorId, RunDtos.StartRequest request) {
        Agent agent = agentService.requirePublic(slug);
        return startInternal(agent, request, requireVisitor(visitorId));
    }

    private RunDtos.StartResponse startInternal(Agent agent, RunDtos.StartRequest request, String visitorId) {
        return startInternal(agent, request, visitorId, null);
    }

    private RunDtos.StartResponse startInternal(Agent agent, RunDtos.StartRequest request, String visitorId,
                                               String retryOfRunId) {
        JsonNode graph = readTree(agent.getGraphJson());
        Map<String, Object> input = request.input() == null ? Map.of() : request.input();
        Instant now = Timestamps.now();

        Conversation conversation = resolveConversation(request.conversationId(), agent.getId(), visitorId, input, now);

        // 同一会话上并发起两轮会各自算出同一个 seq（第一轮的助手消息还没落库），
        // 撞上 message 的 (conversation_id, seq) 唯一约束会让其中一轮整轮丢失。
        // 这里直接拒绝，语义也更清楚：等上一轮答完再发。
        if (runRepo.existsByConversationIdAndStatusIn(conversation.getId(), ACTIVE_STATUSES)) {
            throw ApiException.conflict("上一轮还在进行中，请等它结束后再发下一条");
        }

        int userSeq = messageRepo.findMaxSeq(conversation.getId()) + 1;
        List<RuntimeClient.HistoryMessage> history = messageRepo
                .findByConversationIdOrderBySeqAsc(conversation.getId()).stream()
                .map(m -> new RuntimeClient.HistoryMessage(m.getRole(), m.getContent()))
                .toList();

        Run run = new Run(UUID.randomUUID().toString(), conversation.getId(), agent.getId(),
                RunStatus.QUEUED, writeJson(input), now);
        if (retryOfRunId != null) {
            // 血缘必须在创建时就带上：run 落库后编排线程会立刻在自己的事务里再保存一次，
            // "先建后改"的写法会被那次保存覆盖掉（这个坑被 InterruptTraceIT 抓出来过）。
            run.markRetryOf(retryOfRunId);
        }
        runRepo.save(run);

        messageRepo.save(new Message(UUID.randomUUID().toString(), conversation.getId(), run.getId(),
                userSeq, "user", renderInput(input), null, now));

        // 关键顺序：编排线程必须在【本事务提交之后】才启动。
        // 否则异步线程读不到尚未提交的 run 行，Hibernate 会把它当成新实体再 INSERT 一次，
        // 直接撞上 run 的主键冲突（这个 bug 正是被 RunFlowIT 抓出来的）。
        Runnable launch = () -> orchestrator.start(run, graph, agent.getGraphSchemaVersion(), input, history);
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    launch.run();
                }
            });
        } else {
            launch.run();
        }

        return new RunDtos.StartResponse(run.getId(), conversation.getId());
    }

    // ---------------------------------------------------------------- 中断 / 回退 / 重试

    /**
     * 中断一次运行。
     *
     * 幂等：run 已经结束时 cancel 返回 false，接口仍然返回当前状态，
     * 前端不需要区分"刚停下"和"早就结束了"。
     */
    @Transactional
    public RunDtos.RunView cancel(String ownerId, String runId) {
        requireOwnedRun(ownerId, runId);
        orchestrator.cancel(runId);
        return toView(runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId)));
    }

    @Transactional
    public RunDtos.RunView cancelPublic(String slug, String visitorId, String runId) {
        requirePublicRun(slug, visitorId, runId);
        orchestrator.cancel(runId);
        return toView(runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId)));
    }

    /**
     * 会话回退：删掉 seq &gt; keepSeq 的消息及其所属 run。
     *
     * 这是"修改上一条消息并重发"的基础 —— 先退回到那条消息之前，
     * 再用新内容发起一轮；否则旧回答会作为历史继续影响新问题。
     * 删除 run 会级联清掉它的 run_event 与 trace_span，不会留下孤儿轨迹。
     */
    @Transactional
    public List<RunDtos.MessageView> rewind(String ownerId, String conversationId, int keepSeq) {
        requireOwnedConversation(ownerId, conversationId);
        return rewindInternal(conversationId, keepSeq);
    }

    @Transactional
    public List<RunDtos.MessageView> rewindPublic(String slug, String visitorId, String conversationId, int keepSeq) {
        Agent agent = agentService.requirePublic(slug);
        requireVisitorConversation(agent.getId(), requireVisitor(visitorId), conversationId);
        return rewindInternal(conversationId, keepSeq);
    }

    private List<RunDtos.MessageView> rewindInternal(String conversationId, int keepSeq) {
        // 先停掉这一会话上还在跑的轮次：否则它会在回退之后继续往会话里写消息
        for (Run active : runRepo.findByConversationIdAndStatusIn(conversationId, ACTIVE_STATUSES)) {
            orchestrator.cancel(active.getId());
        }
        List<Message> doomed = messageRepo
                .findByConversationIdAndSeqGreaterThanOrderBySeqAsc(conversationId, keepSeq);
        Set<String> runIds = doomed.stream().map(Message::getRunId).filter(Objects::nonNull)
                .collect(Collectors.toSet());
        messageRepo.deleteAll(doomed);
        if (!runIds.isEmpty()) {
            runRepo.deleteAllById(runIds);
        }
        return messageRepo.findByConversationIdOrderBySeqAsc(conversationId).stream().map(this::toView).toList();
    }

    /** 断点重试：从这一轮之前重新跑同样的输入。 */
    @Transactional
    public RunDtos.StartResponse retry(String ownerId, String runId) {
        Run original = requireOwnedRun(ownerId, runId);
        Agent agent = agentService.require(original.getAgentId(), ownerId);
        return retryInternal(agent, original, null);
    }

    @Transactional
    public RunDtos.StartResponse retryPublic(String slug, String visitorId, String runId) {
        Agent agent = agentService.requirePublic(slug);
        String visitor = requireVisitor(visitorId);
        Run original = runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId));
        requireVisitorConversation(agent.getId(), visitor, original.getConversationId());
        return retryInternal(agent, original, visitor);
    }

    /**
     * 断点重试的实现。
     *
     * 粒度是【一轮】而不是【一个节点】：runtime 被刻意设计成无状态（历史每次从 MySQL 全量下发），
     * 所以"断点"就是上一次完整轮次的边界。半截输出先被回退掉，再用同样的输入重跑 ——
     * 这样重试不会把失败的部分喂回模型当作上下文。
     */
    private RunDtos.StartResponse retryInternal(Agent agent, Run original, String visitorId) {
        Map<String, Object> input = readInput(original.getInputJson());
        Integer userSeq = messageRepo.findFirstByRunIdAndRoleOrderBySeqAsc(original.getId(), "user")
                .map(Message::getSeq).orElse(null);
        if (userSeq != null) {
            rewindInternal(original.getConversationId(), userSeq - 1);
        }
        return startInternal(agent, new RunDtos.StartRequest(input, original.getConversationId()),
                visitorId, original.getId());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readInput(String inputJson) {
        if (inputJson == null || inputJson.isBlank()) {
            return Map.of();
        }
        try {
            return mapper.readValue(inputJson, Map.class);
        } catch (JsonProcessingException e) {
            return Map.of();
        }
    }

    // ---------------------------------------------------------------- 读（主人）

    @Transactional(readOnly = true)
    public RunDtos.RunView get(String ownerId, String runId) {
        return toView(requireOwnedRun(ownerId, runId));
    }

    @Transactional(readOnly = true)
    public List<RunDtos.MessageView> messagesOfRun(String ownerId, String runId) {
        requireOwnedRun(ownerId, runId);
        return messageRepo.findByRunIdOrderBySeqAsc(runId).stream().map(this::toView).toList();
    }

    @Transactional(readOnly = true)
    public List<RunDtos.MessageView> messagesOfConversation(String ownerId, String conversationId) {
        requireOwnedConversation(ownerId, conversationId);
        return messageRepo.findByConversationIdOrderBySeqAsc(conversationId).stream().map(this::toView).toList();
    }

    /** 某个 agent 的会话列表（含公开页面访客开的会话，会带 fromVisitor 标记）。 */
    @Transactional(readOnly = true)
    public List<ConversationDtos.Summary> listConversations(String ownerId, String agentId) {
        agentService.require(agentId, ownerId);
        return conversationRepo.findByAgentIdOrderByCreatedAtDesc(agentId).stream()
                .map(c -> new ConversationDtos.Summary(c.getId(), c.getTitle(),
                        c.getVisitorId() != null, messageRepo.countByConversationId(c.getId()), c.getCreatedAt()))
                .toList();
    }

    // ---------------------------------------------------------------- 读（访客）

    @Transactional(readOnly = true)
    public List<ConversationDtos.Summary> listPublicConversations(String slug, String visitorId) {
        Agent agent = agentService.requirePublic(slug);
        String visitor = requireVisitor(visitorId);
        return conversationRepo.findByAgentIdAndVisitorIdOrderByCreatedAtDesc(agent.getId(), visitor).stream()
                .map(c -> new ConversationDtos.Summary(c.getId(), c.getTitle(), true,
                        messageRepo.countByConversationId(c.getId()), c.getCreatedAt()))
                .toList();
    }

    @Transactional(readOnly = true)
    public List<RunDtos.MessageView> publicMessages(String slug, String visitorId, String conversationId) {
        Agent agent = agentService.requirePublic(slug);
        requireVisitorConversation(agent.getId(), requireVisitor(visitorId), conversationId);
        return messageRepo.findByConversationIdOrderBySeqAsc(conversationId).stream().map(this::toView).toList();
    }

    /** 公开页面的 SSE 也需要鉴权（按访客隔离），所以校验 run 归属后再交给流服务。 */
    @Transactional(readOnly = true)
    public Run requirePublicRun(String slug, String visitorId, String runId) {
        Agent agent = agentService.requirePublic(slug);
        Run run = runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId));
        requireVisitorConversation(agent.getId(), requireVisitor(visitorId), run.getConversationId());
        return run;
    }

    // ---------------------------------------------------------------- 校验

    /**
     * 只按 id 取 run，【不做归属校验】。
     *
     * 仅供 RunStreamService 这类"控制器已经校验过归属"的内部调用使用；
     * 控制器一律用 requireOwnedRun / requirePublicRun，不要直接用它。
     */
    @Transactional(readOnly = true)
    public Run requireRun(String runId) {
        return runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId));
    }

    @Transactional(readOnly = true)
    public Run requireOwnedRun(String ownerId, String runId) {
        Run run = runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId));
        requireOwnedConversation(ownerId, run.getConversationId());
        return run;
    }

    /** 供轨迹查询等只读接口复用的归属校验。 */
    @Transactional(readOnly = true)
    public void requireConversationAccess(String ownerId, String conversationId) {
        requireOwnedConversation(ownerId, conversationId);
    }

    private Conversation requireOwnedConversation(String ownerId, String conversationId) {
        Conversation conversation = conversationRepo.findById(conversationId)
                .orElseThrow(() -> ApiException.notFound("conversation", conversationId));
        // agentService.require 会校验归属，非本人直接 404
        agentService.require(conversation.getAgentId(), ownerId);
        return conversation;
    }

    private Conversation requireVisitorConversation(String agentId, String visitorId, String conversationId) {
        Conversation conversation = conversationRepo.findById(conversationId)
                .orElseThrow(() -> ApiException.notFound("conversation", conversationId));
        if (!conversation.getAgentId().equals(agentId) || !visitorId.equals(conversation.getVisitorId())) {
            // 不属于这个访客的会话一律当作不存在，避免用别人的 conversationId 读到记录
            throw ApiException.notFound("conversation", conversationId);
        }
        return conversation;
    }

    static String requireVisitor(String visitorId) {
        String trimmed = visitorId == null ? "" : visitorId.trim();
        if (trimmed.isEmpty() || trimmed.length() > VISITOR_ID_MAX_LENGTH) {
            throw ApiException.invalid("缺少有效的访客标识");
        }
        return trimmed;
    }

    // ---------------------------------------------------------------- 内部

    private Conversation resolveConversation(String conversationId, String agentId, String visitorId,
                                             Map<String, Object> input, Instant now) {
        if (conversationId == null || conversationId.isBlank()) {
            return conversationRepo.save(new Conversation(UUID.randomUUID().toString(), agentId, visitorId,
                    deriveTitle(input), now));
        }
        // 加行锁：把"上面的活跃轮次检查"与"下面插入新 run"串行化，
        // 否则两个并发请求可能同时通过检查。
        Conversation existing = conversationRepo.lockById(conversationId)
                .orElseThrow(() -> ApiException.notFound("conversation", conversationId));
        if (!existing.getAgentId().equals(agentId)) {
            throw ApiException.invalid("会话 " + conversationId + " 不属于 agent " + agentId);
        }
        if (visitorId != null && !visitorId.equals(existing.getVisitorId())) {
            throw ApiException.notFound("conversation", conversationId);
        }
        return existing;
    }

    private RunDtos.RunView toView(Run run) {
        return new RunDtos.RunView(run.getId(), run.getAgentId(), run.getConversationId(),
                run.getStatus().name(), readTreeOrNull(run.getInputJson()), run.getAnswer(),
                readTreeOrNull(run.getErrorJson()), run.getStartedAt(), run.getFinishedAt());
    }

    private RunDtos.MessageView toView(Message message) {
        return new RunDtos.MessageView(message.getId(), message.getRunId(), message.getSeq(), message.getRole(),
                message.getContent(), readTreeOrNull(message.getToolCallsJson()), message.getCreatedAt());
    }

    /** 单变量输入直接用值，多变量输入用 "k: v" 多行，便于在对话流里显示。 */
    private String renderInput(Map<String, Object> input) {
        if (input.isEmpty()) {
            return "(空输入)";
        }
        if (input.size() == 1) {
            Object only = input.values().iterator().next();
            return only == null ? "(空输入)" : String.valueOf(only);
        }
        Map<String, Object> ordered = new LinkedHashMap<>(input);
        return ordered.entrySet().stream()
                .map(e -> e.getKey() + ": " + e.getValue())
                .collect(Collectors.joining("\n"));
    }

    private String deriveTitle(Map<String, Object> input) {
        String rendered = renderInput(input).replace('\n', ' ');
        if (rendered.length() > 60) {
            return rendered.substring(0, 60) + "…";
        }
        return rendered;
    }

    private JsonNode readTree(String json) {
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("非法 JSON", e);
        }
    }

    private JsonNode readTreeOrNull(String json) {
        return json == null ? null : readTree(json);
    }

    private String writeJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw ApiException.invalid("input 无法序列化: " + e.getMessage());
        }
    }
}
