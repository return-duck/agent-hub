package local.agentstack.run;

import local.agentstack.protocol.ProtocolEvent;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * 一次 run 的事件通道（内存）。
 *
 * 为什么内存里存全量事件而不是每次查库：SSE 的"先订阅再回放"必须相对 publish 原子，
 * 否则回放与订阅之间存在窗口会丢事件。这里用同一把锁把二者串起来，
 * 浏览器连接时只要带上 afterSeq（或 Last-Event-ID）就不会丢、也不会重。
 *
 * 权衡：send 在锁内执行，慢客户端会短暂阻塞 orchestrator。MVP 场景（本机单客户端）可接受，
 * 水平扩展时这一层应换成 Redis Stream / 消息队列。
 */
public final class RunEventChannel {

    private final String runId;
    private final List<ProtocolEvent> events = new ArrayList<>();
    private final List<SseEmitter> subscribers = new ArrayList<>();
    private volatile boolean completed;
    private volatile Instant completedAt;

    public RunEventChannel(String runId) {
        this.runId = runId;
    }

    public String runId() {
        return runId;
    }

    public synchronized void publish(ProtocolEvent event) {
        events.add(event);
        Iterator<SseEmitter> it = subscribers.iterator();
        while (it.hasNext()) {
            if (!send(it.next(), event)) {
                it.remove();
            }
        }
    }

    public synchronized void subscribe(SseEmitter emitter, int afterSeq) {
        for (ProtocolEvent event : events) {
            if (event.seq() > afterSeq && !send(emitter, event)) {
                return;
            }
        }
        if (completed) {
            emitter.complete();
            return;
        }
        subscribers.add(emitter);
    }

    public synchronized void unsubscribe(SseEmitter emitter) {
        subscribers.remove(emitter);
    }

    public synchronized void complete() {
        completed = true;
        completedAt = Instant.now();
        for (SseEmitter emitter : subscribers) {
            try {
                emitter.complete();
            } catch (RuntimeException ignored) {
                // 客户端已断开
            }
        }
        subscribers.clear();
    }

    public boolean isCompleted() {
        return completed;
    }

    public Instant completedAt() {
        return completedAt;
    }

    public synchronized int lastSeq() {
        return events.isEmpty() ? 0 : events.get(events.size() - 1).seq();
    }

    private boolean send(SseEmitter emitter, ProtocolEvent event) {
        try {
            emitter.send(SseEmitter.event()
                    .id(String.valueOf(event.seq()))
                    .name(event.type())
                    .data(event, MediaType.APPLICATION_JSON));
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
