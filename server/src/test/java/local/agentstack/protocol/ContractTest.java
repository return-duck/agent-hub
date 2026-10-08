package local.agentstack.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 契约测试（Java 侧）：读取与 runtime / web 完全相同的 contracts/ 真源，断言不会漂移。
 *
 * 这是"Java 只对信封建模、不解读事件"这一决策的配套保障：
 * 因为我们不在 Java 里为 10 个事件生成类型，所以必须有测试把枚举和 fixture 钉在一起。
 */
class ContractTest {

    private static final Path CONTRACTS = Path.of("..", "contracts");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    @DisplayName("EventType 枚举覆盖录制事件流里出现的所有类型，且不多不少")
    void eventTypeEnumMatchesRecordedFixture() throws IOException {
        Path fixture = CONTRACTS.resolve("fixtures").resolve("events.jsonl");
        assertThat(fixture).as("缺少录制的契约 fixture: %s", fixture.toAbsolutePath()).exists();

        Set<String> seen = new HashSet<>();
        List<String> lines;
        try (Stream<String> stream = Files.lines(fixture)) {
            lines = stream.map(String::trim).filter(line -> !line.isEmpty()).toList();
        }
        assertThat(lines).hasSizeGreaterThan(10);

        for (String line : lines) {
            JsonNode node = MAPPER.readTree(line);
            String type = node.path("type").asText();
            assertThat(EventType.isKnown(type)).as("Java 侧不认识事件类型: %s", type).isTrue();
            seen.add(type);
            // seq 由 server 分配，runtime 产出的事件里不应该有
            assertThat(node.has("seq")).as("runtime 不应产出 seq: %s", line).isFalse();
        }

        Set<String> declared = new HashSet<>();
        for (EventType type : EventType.values()) {
            declared.add(type.wire());
        }
        // 录制流覆盖了除 run.error 之外的全部类型
        Set<String> expectedSeen = new HashSet<>(declared);
        expectedSeen.remove("run.error");
        assertThat(seen).containsExactlyInAnyOrderElementsOf(expectedSeen);
    }

    @Test
    @DisplayName("NodeType 枚举与 node-manifest.json 的 nodeTypes 完全一致")
    void nodeTypeEnumMatchesManifest() throws IOException {
        Path manifest = CONTRACTS.resolve("node-manifest.json");
        assertThat(manifest).exists();

        JsonNode root = MAPPER.readTree(Files.readString(manifest));
        Set<String> fromManifest = new HashSet<>();
        for (JsonNode node : root.path("nodeTypes")) {
            fromManifest.add(node.path("type").asText());
        }

        assertThat(NodeType.all()).containsExactlyInAnyOrderElementsOf(fromManifest);
    }

    @Test
    @DisplayName("事件 payload 里的 error code 枚举与 schema 对齐（新增 code 时 Java 侧会红）")
    void errorCodesMatchSchema() throws IOException {
        JsonNode schema = MAPPER.readTree(Files.readString(CONTRACTS.resolve("events.schema.json")));
        Set<String> fromSchema = new HashSet<>();
        for (JsonNode code : schema.path("$defs").path("runError").path("properties").path("payload")
                .path("properties").path("code").path("enum")) {
            fromSchema.add(code.asText());
        }
        assertThat(fromSchema).contains("INVALID_GRAPH", "INVALID_INPUT", "MODEL_ERROR", "TOOL_ERROR",
                "STEP_LIMIT", "RUNTIME_UNAVAILABLE", "TIMEOUT", "INTERNAL");
    }
}
