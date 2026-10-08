package local.agentstack.api;

import local.agentstack.api.dto.RunDtos;
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
    public ResponseEntity<RunDtos.StartResponse> start(@PathVariable String agentId,
                                                       @RequestBody(required = false) RunDtos.StartRequest request) {
        RunDtos.StartRequest safe = request == null ? new RunDtos.StartRequest(null, null) : request;
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(runService.start(agentId, safe));
    }

    @GetMapping("/runs/{runId}")
    public RunDtos.RunView get(@PathVariable String runId) {
        return runService.get(runId);
    }

    /**
     * 事件流。afterSeq 优先取查询参数，其次取 SSE 标准的 Last-Event-ID 请求头
     * （浏览器 EventSource 断线重连会自动带上它），这样"断线续传"是免费的。
     */
    @GetMapping(value = "/runs/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable String runId,
                             @RequestParam(name = "afterSeq", required = false) Integer afterSeq,
                             @RequestHeader(name = "Last-Event-ID", required = false) String lastEventId) {
        return streamService.open(runId, resolveAfterSeq(afterSeq, lastEventId));
    }

    @GetMapping("/runs/{runId}/messages")
    public List<RunDtos.MessageView> messagesOfRun(@PathVariable String runId) {
        return runService.messagesOfRun(runId);
    }

    @GetMapping("/conversations/{conversationId}/messages")
    public List<RunDtos.MessageView> messagesOfConversation(@PathVariable String conversationId) {
        return runService.messagesOfConversation(conversationId);
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
