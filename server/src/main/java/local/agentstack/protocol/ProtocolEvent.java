package local.agentstack.protocol;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * 协议事件信封。刻意只对"信封"建模：payload 保持为原始 JSON 树，
 * server 不解读事件语义，只负责分配 seq、落库、原样转发给浏览器。
 * 这样契约漂移面从 10 个事件缩小到 1 个信封（见 docs/DESIGN.md 的 ADR）。
 */
public record ProtocolEvent(int seq, String type, String runId, String nodeId, JsonNode payload, Instant ts) {
}
