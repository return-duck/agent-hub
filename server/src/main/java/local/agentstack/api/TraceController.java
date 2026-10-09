package local.agentstack.api;

import local.agentstack.api.dto.TraceDtos;
import local.agentstack.auth.CurrentUser;
import local.agentstack.domain.AppUser;
import local.agentstack.service.AgentService;
import local.agentstack.service.RunService;
import local.agentstack.service.TraceService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 调用轨迹查询（主人视角）。
 *
 * 两级入口：先按 agent 列出最近的 run，再按 run 取它的 span 时间线；
 * 另外提供按会话聚合的视图（一次对话里跨多轮的完整调用轨迹）。
 */
@RestController
@RequestMapping("/api")
public class TraceController {

    private final TraceService traceService;
    private final RunService runService;
    private final AgentService agentService;

    public TraceController(TraceService traceService, RunService runService, AgentService agentService) {
        this.traceService = traceService;
        this.runService = runService;
        this.agentService = agentService;
    }

    @GetMapping("/agents/{agentId}/runs")
    public List<TraceDtos.RunSummary> runs(@CurrentUser AppUser user, @PathVariable String agentId,
                                           @RequestParam(name = "limit", defaultValue = "30") int limit) {
        agentService.require(agentId, user.getId());
        return traceService.recentRuns(agentId, limit);
    }

    @GetMapping("/runs/{runId}/traces")
    public List<TraceDtos.Span> tracesOfRun(@CurrentUser AppUser user, @PathVariable String runId) {
        runService.requireOwnedRun(user.getId(), runId);
        return traceService.spansOfRun(runId);
    }

    @GetMapping("/conversations/{conversationId}/traces")
    public List<TraceDtos.Span> tracesOfConversation(@CurrentUser AppUser user,
                                                     @PathVariable String conversationId) {
        runService.requireConversationAccess(user.getId(), conversationId);
        return traceService.spansOfConversation(conversationId);
    }

    /** 一个会话的完整轨迹（多轮对话在一页里）：轨迹页直接消费这个结构 */
    @GetMapping("/conversations/{conversationId}/trace")
    public TraceDtos.ConversationTrace conversationTrace(@CurrentUser AppUser user,
                                                         @PathVariable String conversationId) {
        runService.requireConversationAccess(user.getId(), conversationId);
        return traceService.conversationTrace(conversationId);
    }
}
