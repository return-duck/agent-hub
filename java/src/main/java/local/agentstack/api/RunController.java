package local.agentstack.api;

import jakarta.validation.Valid;
import local.agentstack.api.dto.RunDtos;
import local.agentstack.auth.CurrentUser;
import local.agentstack.domain.AppUser;
import local.agentstack.run.RunStreamService;
import local.agentstack.service.RunService;
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

@RestController
@RequestMapping("/api")
public class RunController {

    private final RunService runService;
    private final RunStreamService streamService;

    public RunController(RunService runService, RunStreamService streamService) {
        this.runService = runService;
        this.streamService = streamService;
    }

    @PostMapping("/agents/{agentId}/runs")
    public ResponseEntity<RunDtos.StartResponse> start(@CurrentUser AppUser user, @PathVariable String agentId,
                                                       @RequestBody(required = false) RunDtos.StartRequest request) {
        RunDtos.StartRequest safe = request == null ? new RunDtos.StartRequest(null, null) : request;
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(runService.startForOwner(user.getId(), agentId, safe));
    }

    /** 中断运行。幂等：已经结束的 run 也会得到一个正常的当前状态。 */
    @PostMapping("/runs/{runId}/cancel")
    public RunDtos.RunView cancel(@CurrentUser AppUser user, @PathVariable String runId) {
        return runService.cancel(user.getId(), runId);
    }

    /** 断点重试：回退到这一轮之前，用同样的输入重跑。 */
    @PostMapping("/runs/{runId}/retry")
    public ResponseEntity<RunDtos.StartResponse> retry(@CurrentUser AppUser user, @PathVariable String runId) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(runService.retry(user.getId(), runId));
    }

    /** 会话回退：删掉 seq > keepSeq 的消息及其 run。用于"改上一条并重发"。 */
    @PostMapping("/conversations/{conversationId}/rewind")
    public List<RunDtos.MessageView> rewind(@CurrentUser AppUser user, @PathVariable String conversationId,
                                            @Valid @RequestBody RunDtos.RewindRequest request) {
        return runService.rewind(user.getId(), conversationId, request.keepSeq());
    }

    @GetMapping("/runs/{runId}")
    public RunDtos.RunView get(@CurrentUser AppUser user, @PathVariable String runId) {
        return runService.get(user.getId(), runId);
    }

    /**
     * 事件流。afterSeq 优先取查询参数，其次取 SSE 标准的 Last-Event-ID 请求头
     * （浏览器 EventSource 断线重连会自动带上它），这样"断线续传"是免费的。
     * 打开流之前先校验 run 归属，否则任何人猜到 runId 就能看别人的输出。
     */
    @GetMapping(value = "/runs/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@CurrentUser AppUser user, @PathVariable String runId,
                             @RequestParam(name = "afterSeq", required = false) Integer afterSeq,
                             @RequestHeader(name = "Last-Event-ID", required = false) String lastEventId) {
        runService.requireOwnedRun(user.getId(), runId);
        return streamService.open(runId, resolveAfterSeq(afterSeq, lastEventId));
    }

    @GetMapping("/runs/{runId}/messages")
    public List<RunDtos.MessageView> messagesOfRun(@CurrentUser AppUser user, @PathVariable String runId) {
        return runService.messagesOfRun(user.getId(), runId);
    }

    @GetMapping("/conversations/{conversationId}/messages")
    public List<RunDtos.MessageView> messagesOfConversation(@CurrentUser AppUser user,
                                                            @PathVariable String conversationId) {
        return runService.messagesOfConversation(user.getId(), conversationId);
    }

    static int resolveAfterSeq(Integer afterSeq, String lastEventId) {
        if (afterSeq != null) {
            return Math.max(afterSeq, 0);
        }
        if (lastEventId == null || lastEventId.isBlank()) {
            return 0;
        }
        try {
            return Math.max(Integer.parseInt(lastEventId.trim()), 0);
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
