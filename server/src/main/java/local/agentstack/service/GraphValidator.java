package local.agentstack.service;

import com.fasterxml.jackson.databind.JsonNode;
import local.agentstack.protocol.NodeType;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 保存期的【浅层】校验：JSON 可解析、schemaVersion 正确、id 唯一、类型已知、边指向存在的节点。
 *
 * 刻意不做"单入口 / 可达性 / 无环"这类深层语义校验——那是 runtime 编译器的职责，
 * 在两端各写一遍必然漂移。运行时的编译错误会带 nodeId 回传到前端画布上标红。
 */
public final class GraphValidator {

    public static final int SUPPORTED_SCHEMA_VERSION = 1;

    private GraphValidator() {
    }

    /** @return 问题列表，空表示通过。每项含 code / nodeId / message。 */
    public static List<Map<String, Object>> validate(JsonNode graph) {
        List<Map<String, Object>> problems = new ArrayList<>();

        if (graph == null || !graph.isObject()) {
            return List.of(problem("MISSING_GRAPH", null, "缺少 graph 对象"));
        }

        JsonNode version = graph.get("schemaVersion");
        if (version == null || !version.isInt()) {
            problems.add(problem("MISSING_SCHEMA_VERSION", null, "缺少 graph.schemaVersion"));
        } else if (version.asInt() != SUPPORTED_SCHEMA_VERSION) {
            problems.add(problem("UNSUPPORTED_SCHEMA_VERSION", null,
                    "不支持的 schemaVersion=" + version.asInt() + "，当前仅支持 " + SUPPORTED_SCHEMA_VERSION));
        }

        JsonNode nodes = graph.get("nodes");
        if (nodes == null || !nodes.isArray() || nodes.isEmpty()) {
            problems.add(problem("EMPTY_GRAPH", null, "graph.nodes 必须是非空数组"));
            return problems;
        }

        Set<String> ids = new HashSet<>();
        for (JsonNode node : nodes) {
            String id = text(node, "id");
            if (id == null || id.isBlank()) {
                problems.add(problem("NODE_MISSING_ID", null, "存在缺少 id 的节点"));
                continue;
            }
            if (!ids.add(id)) {
                problems.add(problem("DUPLICATE_NODE_ID", id, "节点 id 重复: " + id));
            }
            String type = text(node, "type");
            if (type == null || !NodeType.isKnown(type)) {
                problems.add(problem("UNKNOWN_NODE_TYPE", id, "未知节点类型: " + type));
            }
            JsonNode data = node.get("data");
            if (data == null || !data.isObject() || data.get("config") == null) {
                problems.add(problem("NODE_MISSING_CONFIG", id, "节点缺少 data.config"));
            }
        }

        JsonNode edges = graph.get("edges");
        if (edges == null || !edges.isArray()) {
            problems.add(problem("MISSING_EDGES", null, "graph.edges 必须是数组"));
            return problems;
        }
        Set<String> edgeIds = new HashSet<>();
        for (JsonNode edge : edges) {
            String edgeId = text(edge, "id");
            if (edgeId == null || edgeId.isBlank()) {
                problems.add(problem("EDGE_MISSING_ID", null, "存在缺少 id 的连线"));
            } else if (!edgeIds.add(edgeId)) {
                problems.add(problem("DUPLICATE_EDGE_ID", null, "连线 id 重复: " + edgeId));
            }
            String source = text(edge, "source");
            String target = text(edge, "target");
            if (source == null || !ids.contains(source)) {
                problems.add(problem("EDGE_UNKNOWN_SOURCE", source, "连线起点不存在: " + source));
            }
            if (target == null || !ids.contains(target)) {
                problems.add(problem("EDGE_UNKNOWN_TARGET", target, "连线终点不存在: " + target));
            }
        }

        return problems;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private static Map<String, Object> problem(String code, String nodeId, String message) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("code", code);
        map.put("nodeId", nodeId);
        map.put("message", message);
        return map;
    }
}
