package local.agentstack.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.api.ApiException;
import local.agentstack.api.dto.RunDtos;
import local.agentstack.domain.Agent;
import local.agentstack.domain.Conversation;
import local.agentstack.domain.Message;
import local.agentstack.domain.Run;
import local.agentstack.domain.Timestamps;
import local.agentstack.domain.RunStatus;
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
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class RunService {

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

    /**
     * 新建一次运行。会话历史在这里从 MySQL 读出并全量下发给 runtime，
     * 因此 runtime 完全无状态：重启或多副本都不会丢会话上下文。
     */
    @Transactional
    public RunDtos.StartResponse start(String agentId, RunDtos.StartRequest request) {
        Agent agent = agentService.require(agentId);
        JsonNode graph = readTree(agent.getGraphJson());
        Map<String, Object> input = request.input() == null ? Map.of() : request.input();
        Instant now = Timestamps.now();

        Conversation conversation = resolveConversation(request.conversationId(), agentId, input, now);

        int userSeq = messageRepo.findMaxSeq(conversation.getId()) + 1;
        List<RuntimeClient.HistoryMessage> history = messageRepo
                .findByConversationIdOrderBySeqAsc(conversation.getId()).stream()
                .map(m -> new RuntimeClient.HistoryMessage(m.getRole(), m.getContent()))
                .toList();

        Run run = new Run(UUID.randomUUID().toString(), conversation.getId(), agentId,
                RunStatus.QUEUED, writeJson(input), now);
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

    @Transactional(readOnly = true)
    public RunDtos.RunView get(String runId) {
        return toView(require(runId));
    }

    @Transactional(readOnly = true)
    public List<RunDtos.MessageView> messagesOfRun(String runId) {
        require(runId);
        return messageRepo.findByRunIdOrderBySeqAsc(runId).stream().map(this::toView).toList();
    }

    @Transactional(readOnly = true)
    public List<RunDtos.MessageView> messagesOfConversation(String conversationId) {
        if (!conversationRepo.existsById(conversationId)) {
            throw ApiException.notFound("conversation", conversationId);
        }
        return messageRepo.findByConversationIdOrderBySeqAsc(conversationId).stream().map(this::toView).toList();
    }

    @Transactional(readOnly = true)
    public Run require(String runId) {
        return runRepo.findById(runId).orElseThrow(() -> ApiException.notFound("run", runId));
    }

    @Transactional(readOnly = true)
    public List<RunDtos.RunView> recentRuns(String conversationId) {
        return runRepo.findByConversationIdOrderByStartedAtDesc(conversationId).stream().map(this::toView).toList();
    }

    private Conversation resolveConversation(String conversationId, String agentId,
                                             Map<String, Object> input, Instant now) {
        if (conversationId == null || conversationId.isBlank()) {
            return conversationRepo.save(new Conversation(UUID.randomUUID().toString(), agentId,
                    deriveTitle(input), now));
        }
        Conversation existing = conversationRepo.findById(conversationId)
                .orElseThrow(() -> ApiException.notFound("conversation", conversationId));
        if (!existing.getAgentId().equals(agentId)) {
            throw ApiException.invalid("会话 " + conversationId + " 不属于 agent " + agentId);
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
