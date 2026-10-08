package local.agentstack.protocol;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 已知节点类型。与 contracts/node-manifest.json 的 nodeTypes 一一对应，
 * 由 NodeTypeContractTest 断言两者不会漂移。
 */
public enum NodeType {
    START("start"),
    PROMPT("prompt"),
    LLM("llm"),
    END("end");

    private final String wire;

    NodeType(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    private static final Set<String> WIRES =
            Arrays.stream(values()).map(NodeType::wire).collect(Collectors.toUnmodifiableSet());

    public static boolean isKnown(String wire) {
        return WIRES.contains(wire);
    }

    public static Set<String> all() {
        return WIRES;
    }
}
