package local.agentstack.api;

import local.agentstack.protocol.NodeType;
import local.agentstack.run.RuntimeClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 运行时就绪情况。前端用它决定是否显示"当前使用内置脚本化模型"的横幅。
 */
@RestController
@RequestMapping("/api")
public class CapabilityController {

    private final RuntimeClient runtimeClient;

    public CapabilityController(RuntimeClient runtimeClient) {
        this.runtimeClient = runtimeClient;
    }

    @GetMapping("/capabilities")
    public Map<String, Object> capabilities() {
        RuntimeClient.Health health = runtimeClient.health();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runtimeUp", health.ok());
        body.put("modelMode", health.modelMode());
        body.put("modelName", health.modelName());
        body.put("nodeTypes", List.copyOf(NodeType.all()));
        return body;
    }
}
