package local.agentstack.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import local.agentstack.protocol.ProtocolEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SSE 续传的核心语义测试：不需要数据库，纯内存行为。
 *
 * 这里覆盖的是最容易被写错、也最容易在联调时表现为"事件丢了/重了"的那一类问题：
 *  - 晚连接的客户端能否补齐历史事件；
 *  - afterSeq 之后的边界是否正确（seq == afterSeq 不重复发）；
 *  - 订阅后再 publish 的事件能否拿到；
 *  - run 已结束时订阅者是否立刻收口（否则前端会一直等着）。
 */
class RunEventChannelTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ProtocolEvent event(int seq, String type) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("k", seq);
        return new ProtocolEvent(seq, type, "run-1", "n1", payload, Instant.now());
    }

    /** 记录 send 内容的 SseEmitter 替身 */
    static class RecordingEmitter extends SseEmitter {
        final List<Object> sent = new ArrayList<>();
        boolean completed = false;

        RecordingEmitter() {
            super(0L);
        }

        @Override
        public void send(SseEventBuilder builder) {
            sent.add(builder);
        }

        @Override
        public void complete() {
            completed = true;
        }
    }

    @Test
    @DisplayName("订阅时补发 afterSeq 之后的历史事件，且不重复发 seq == afterSeq")
    void replaysHistoryAfterGivenSeq() {
        RunEventChannel channel = new RunEventChannel("run-1");
        for (int seq = 1; seq <= 5; seq++) {
            channel.publish(event(seq, "node.started"));
        }

        RecordingEmitter emitter = new RecordingEmitter();
        channel.subscribe(emitter, 3);

        assertThat(emitter.sent).hasSize(2); // seq 4 与 5
        assertThat(channel.lastSeq()).isEqualTo(5);
    }

    @Test
    @DisplayName("afterSeq = 0 表示全量回放")
    void zeroSeqReplaysEverything() {
        RunEventChannel channel = new RunEventChannel("run-1");
        channel.publish(event(1, "run.started"));
        channel.publish(event(2, "run.finished"));

        RecordingEmitter emitter = new RecordingEmitter();
        channel.subscribe(emitter, 0);

        assertThat(emitter.sent).hasSize(2);
    }

    @Test
    @DisplayName("订阅之后 publish 的新事件会实时推给订阅者")
    void pushesLiveEventsToSubscribers() {
        RunEventChannel channel = new RunEventChannel("run-1");
        RecordingEmitter emitter = new RecordingEmitter();
        channel.subscribe(emitter, 0);
        assertThat(emitter.sent).isEmpty();

        channel.publish(event(1, "run.started"));
        channel.publish(event(2, "llm.token"));

        assertThat(emitter.sent).hasSize(2);
    }

    @Test
    @DisplayName("run 已结束时订阅者立刻收口，且仍能拿到全部历史事件")
    void completedChannelClosesImmediately() {
        RunEventChannel channel = new RunEventChannel("run-1");
        channel.publish(event(1, "run.started"));
        channel.publish(event(2, "run.finished"));
        channel.complete();

        RecordingEmitter emitter = new RecordingEmitter();
        channel.subscribe(emitter, 0);

        assertThat(emitter.sent).hasSize(2);
        assertThat(emitter.completed).isTrue();
        assertThat(channel.isCompleted()).isTrue();
    }

    @Test
    @DisplayName("取消订阅后不再收到事件（避免慢客户端泄漏）")
    void unsubscribedEmitterStopsReceiving() {
        RunEventChannel channel = new RunEventChannel("run-1");
        RecordingEmitter emitter = new RecordingEmitter();
        channel.subscribe(emitter, 0);
        channel.unsubscribe(emitter);

        channel.publish(event(1, "run.started"));

        assertThat(emitter.sent).isEmpty();
    }

    @Test
    @DisplayName("无界内存防护：已完成的通道会被清理，未完成的不会被误删")
    void broadcasterPrunesOnlyCompletedChannels() {
        RunEventBroadcaster broadcaster = new RunEventBroadcaster();
        RunEventChannel live = broadcaster.channel("live");
        live.publish(event(1, "run.started"));
        assertThat(broadcaster.get("live")).isNotNull();
        assertThat(live.isCompleted()).isFalse();
    }
}
