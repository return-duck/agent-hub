package local.agentstack;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** 测试用的画布图（与 runtime 的 fixtures 保持同一形状，避免测试里出现"另一种图"） */
final class GraphFixtures {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private GraphFixtures() {
    }

    /** start → prompt → llm(绑定 calculator) → end */
    static JsonNode withTools() {
        return parse("""
                {
                  "schemaVersion": 1,
                  "nodes": [
                    {"id":"n1","type":"start","position":{"x":0,"y":0},
                     "data":{"label":"开始","config":{"inputVariables":[{"name":"topic","type":"string","required":true}]}}},
                    {"id":"n2","type":"prompt","position":{"x":240,"y":0},
                     "data":{"label":"提示词","config":{"role":"human","template":"请帮我算一下：{{input.topic}}"}}},
                    {"id":"n3","type":"llm","position":{"x":480,"y":0},
                     "data":{"label":"大模型","config":{"temperature":0.2,"tools":["calculator"],"maxSteps":6,"outputKey":"answer"}}},
                    {"id":"n4","type":"end","position":{"x":720,"y":0},
                     "data":{"label":"结束","config":{"outputKey":"answer"}}}
                  ],
                  "edges": [
                    {"id":"e1","source":"n1","target":"n2"},
                    {"id":"e2","source":"n2","target":"n3"},
                    {"id":"e3","source":"n3","target":"n4"}
                  ]
                }
                """);
    }

    /** start → end */
    static JsonNode minimal() {
        return parse("""
                {
                  "schemaVersion": 1,
                  "nodes": [
                    {"id":"n1","type":"start","position":{"x":0,"y":0},
                     "data":{"config":{"inputVariables":[]}}},
                    {"id":"n4","type":"end","position":{"x":240,"y":0},
                     "data":{"config":{"outputKey":"answer"}}}
                  ],
                  "edges": [{"id":"e1","source":"n1","target":"n4"}]
                }
                """);
    }

    private static JsonNode parse(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
