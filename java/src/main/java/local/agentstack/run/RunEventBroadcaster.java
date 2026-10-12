package local.agentstack.run;

import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * runId -> 事件通道。已完成的通道保留一小段时间（便于刷新页面后回放），
 * 之后被清理，避免内存无界增长。
 */
@Component
public class RunEventBroadcaster {

    private static final Duration RETENTION = Duration.ofMinutes(10);
    private static final int MAX_CHANNELS = 128;

    private final Map<String, RunEventChannel> channels = new ConcurrentHashMap<>();

    /** 取（必要时创建）通道：orchestrator 与 SSE 订阅者必须拿到同一个实例。 */
    public RunEventChannel channel(String runId) {
        prune();
        return channels.computeIfAbsent(runId, RunEventChannel::new);
    }

    /** 只取不建：用于区分"正在跑"与"早已结束（走数据库回放）"。 */
    public RunEventChannel get(String runId) {
        return channels.get(runId);
    }

    public void remove(String runId) {
        channels.remove(runId);
    }

    public int size() {
        return channels.size();
    }

    private void prune() {
        Instant now = Instant.now();
        channels.values().removeIf(c ->
                c.isCompleted() && c.completedAt() != null && c.completedAt().isBefore(now.minus(RETENTION)));
        if (channels.size() <= MAX_CHANNELS) {
            return;
        }
        channels.values().stream()
                .filter(RunEventChannel::isCompleted)
                .sorted((a, b) -> a.completedAt().compareTo(b.completedAt()))
                .limit(channels.size() - MAX_CHANNELS)
                .forEach(c -> channels.remove(c.runId()));
    }
}
