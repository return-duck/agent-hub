package local.agentstack.protocol;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 协议事件类型。与 contracts/events.schema.json 的事件一一对应，
 * 由 EventTypeContractTest 用 contracts/fixtures/events.jsonl 断言不遗漏、不多余。
 */
public enum EventType {
    RUN_STARTED("run.started"),
    NODE_STARTED("node.started"),
    NODE_FINISHED("node.finished"),
    LLM_TOKEN("llm.token"),
    LLM_COMPLETED("llm.completed"),
    TOOL_STARTED("tool.started"),
    TOOL_FINISHED("tool.finished"),
    NODE_LOG("node.log"),
    MESSAGE_COMPLETED("message.completed"),
    RUN_ERROR("run.error"),
    RUN_FINISHED("run.finished");

    private final String wire;

    EventType(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    public boolean isTerminal() {
        return this == RUN_FINISHED;
    }

    private static final Set<String> WIRES =
            Arrays.stream(values()).map(EventType::wire).collect(Collectors.toUnmodifiableSet());

    public static boolean isKnown(String wire) {
        return WIRES.contains(wire);
    }
}
