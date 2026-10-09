package local.agentstack.api;

import local.agentstack.api.dto.AgentDtos;
import local.agentstack.api.dto.ConversationDtos;
import local.agentstack.api.dto.RunDtos;
import local.agentstack.api.dto.TraceDtos;
import local.agentstack.domain.Agent;
import local.agentstack.run.RunStreamService;
import local.agentstack.service.AgentService;
import jakarta.validation.Valid;
import local.agentstack.service.RunService;
import local.agentstack.service.TraceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

/**
 * 已发布 agent 的公开访问入口，全部免登录（在 WebConfig 里排除鉴权）。
 *
 * 隔离方式：浏览器本地生成一个 visitorId，服务端把它写到 conversation.visitor_id 上；
 * 之后读会话、读历史、开 SSE 都要求 visitorId 与会话匹配。
 * 用随机 UUID 做"身份"而不是真正的登录，是为了让分享出去的页面点开即用。
 */
@RestController
@RequestMapping("/api/public/agents")
public class PublicController {

    private final AgentService agentService;
    private final RunService runService;
    private final RunStreamService streamService;
    private final TraceService traceService;

    public PublicController(AgentService agentService, RunService runService, RunStreamService streamService,
                            TraceService traceService) {
        this.agentService = agentService;
        this.runService = runService;
        this.streamService = streamService;
        this.traceService = traceService;
    }

    /** 分享页打开时先取 agent 展示信息（不含 graph）。 */
    @GetMapping("/{slug}")
    public AgentDtos.PublicView agent(@PathVariable String slug) {
        Agent agent = agentService.requirePublic(slug);
        return new AgentDtos.PublicView(agent.getPublicSlug(), agent.getName(),
                agent.getDescription(), agent.getPublishedAt());
    }

    @PostMapping("/{slug}/runs")
    public ResponseEntity<RunDtos.StartResponse> start(@PathVariable String slug,
                                                       @RequestBody(required = false) PublicStartRequest request) {
        PublicStartRequest safe = request == null ? new PublicStartRequest(null, null, null) : request;
        RunDtos.StartRequest inner = new RunDtos.StartRequest(safe.input(), safe.conversationId());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(runService.startPublic(slug, safe.visitorId(), inner));
    }

    /** 该访客在这个 agent 下的会话列表。 */
    @GetMapping("/{slug}/conversations")
    public List<ConversationDtos.Summary> conversations(@PathVariable String slug,
                                                        @RequestParam("visitorId") String visitorId) {
        return runService.listPublicConversations(slug, visitorId);
    }

    /** 某个会话的历史消息。 */
    @GetMapping("/{slug}/conversations/{conversationId}/messages")
    public List<RunDtos.MessageView> messages(@PathVariable String slug,
                                              @PathVariable String conversationId,
                                              @RequestParam("visitorId") String visitorId) {
        return runService.publicMessages(slug, visitorId, conversationId);
    }

    @GetMapping(value = "/{slug}/runs/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable String slug, @PathVariable String runId,
                             @RequestParam("visitorId") String visitorId,
                             @RequestParam(name = "afterSeq", required = false) Integer afterSeq,
                             @RequestHeader(name = "Last-Event-ID", required = false) String lastEventId) {
        runService.requirePublicRun(slug, visitorId, runId);
        return streamService.open(runId, RunController.resolveAfterSeq(afterSeq, lastEventId));
    }

    /** 中断访客自己的这一轮。 */
    @PostMapping("/{slug}/runs/{runId}/cancel")
    public RunDtos.RunView cancel(@PathVariable String slug, @PathVariable String runId,
                                  @RequestParam("visitorId") String visitorId) {
        return runService.cancelPublic(slug, visitorId, runId);
    }

    /** 断点重试：回退到这一轮之前重跑。 */
    @PostMapping("/{slug}/runs/{runId}/retry")
    public ResponseEntity<RunDtos.StartResponse> retry(@PathVariable String slug, @PathVariable String runId,
                                                       @RequestParam("visitorId") String visitorId) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(runService.retryPublic(slug, visitorId, runId));
    }

    /** 会话回退：用于"暂停后修改上一条消息并重发"。 */
    @PostMapping("/{slug}/conversations/{conversationId}/rewind")
    public List<RunDtos.MessageView> rewind(@PathVariable String slug, @PathVariable String conversationId,
                                            @Valid @RequestBody RunDtos.PublicRewindRequest request) {
        return runService.rewindPublic(slug, request.visitorId(), conversationId, request.keepSeq());
    }

    /** 该访客自己那一轮的调用轨迹（公开页面也能自查链路）。 */
    @GetMapping("/{slug}/runs/{runId}/traces")
    public List<TraceDtos.Span> traces(@PathVariable String slug, @PathVariable String runId,
                                                              @RequestParam("visitorId") String visitorId) {
        runService.requirePublicRun(slug, visitorId, runId);
        return traceService.spansOfRun(runId);
    }

    /**
     * 一个会话的完整调用轨迹：该访客在这个会话里**每一轮**的模型输入输出、
     * 工具/MCP/技能调用、节点耗时都在同一个响应里，供专门的轨迹页渲染。
     */
    @GetMapping("/{slug}/conversations/{conversationId}/trace")
    public TraceDtos.ConversationTrace conversationTrace(@PathVariable String slug,
                                                         @PathVariable String conversationId,
                                                         @RequestParam("visitorId") String visitorId) {
        runService.requirePublicConversation(slug, visitorId, conversationId);
        return traceService.conversationTrace(conversationId);
    }

    /** 公开请求体：input 是给图用的输入，conversationId 传 null 表示新开会话。 */
    public record PublicStartRequest(java.util.Map<String, Object> input, String conversationId, String visitorId) {
    }
}
