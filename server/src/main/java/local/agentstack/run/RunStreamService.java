package local.agentstack.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.domain.Run;
import local.agentstack.domain.RunEvent;
import local.agentstack.protocol.ProtocolEvent;
import local.agentstack.repo.RunEventRepository;
import local.agentstack.service.RunService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

@Service
public class RunStreamService {

    private static final Logger log = LoggerFactory.getLogger(RunStreamService.class);

    /** 0 表示不超时：长连接由客户端断开或 run 终结来收口。 */
    private static final long NO_TIMEOUT = 0L;

    private final RunEventBroadcaster broadcaster;
    private final RunEventRepository eventRepo;
    private final RunService runService;
    private final ObjectMapper mapper;

    public RunStreamService(RunEventBroadcaster broadcaster, RunEventRepository eventRepo,
                            RunService runService, ObjectMapper mapper) {
        this.broadcaster = broadcaster;
        this.eventRepo = eventRepo;
        this.runService = runService;
        this.mapper = mapper;
    }

    /**
     * 打开某个 run 的事件流。afterSeq 之后的已发生事件会被补发，然后转入直播。
     *
     * 判重与不丢事件依赖两点：SSE 事件 id = seq；通道内部"回放 + 注册订阅"在同一把锁里完成。
     */
    public SseEmitter open(String runId, int afterSeq) {
        Run run = runService.require(runId);
        SseEmitter emitter = new SseEmitter(NO_TIMEOUT);

        RunEventChannel existing = broadcaster.get(runId);
        if (existing == null && run.getStatus().isTerminal()) {
            // 通道已被回收（服务重启或超过保留期），直接从事件表回放
            replayFromDatabase(runId, afterSeq, emitter);
            return emitter;
        }

        RunEventChannel channel = broadcaster.channel(runId);
        emitter.onCompletion(() -> channel.unsubscribe(emitter));
        emitter.onTimeout(() -> channel.unsubscribe(emitter));
        emitter.onError(e -> channel.unsubscribe(emitter));
        channel.subscribe(emitter, afterSeq);
        return emitter;
    }

    private void replayFromDatabase(String runId, int afterSeq, SseEmitter emitter) {
        try {
            List<RunEvent> events = eventRepo.findByRunIdAndSeqGreaterThanOrderBySeqAsc(runId, afterSeq);
            for (RunEvent event : events) {
                ProtocolEvent payload = new ProtocolEvent(event.getSeq(), event.getType(), event.getRunId(),
                        event.getNodeId(), mapper.readTree(event.getPayloadJson()), event.getCreatedAt());
                emitter.send(SseEmitter.event()
                        .id(String.valueOf(event.getSeq()))
                        .name(event.getType())
                        .data(payload, MediaType.APPLICATION_JSON));
            }
            emitter.complete();
        } catch (Exception e) {
            log.warn("回放 run {} 的事件失败: {}", runId, e.getMessage());
            emitter.completeWithError(e);
        }
    }
}
