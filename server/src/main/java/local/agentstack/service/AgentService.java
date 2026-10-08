package local.agentstack.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.api.ApiException;
import local.agentstack.api.dto.AgentDtos;
import local.agentstack.domain.Agent;
import local.agentstack.domain.Timestamps;
import local.agentstack.repo.AgentRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class AgentService {

    private final AgentRepository repo;
    private final ObjectMapper mapper;

    public AgentService(AgentRepository repo, ObjectMapper mapper) {
        this.repo = repo;
        this.mapper = mapper;
    }

    @Transactional(readOnly = true)
    public List<AgentDtos.Summary> list() {
        return repo.findAllByOrderByUpdatedAtDesc().stream().map(this::toSummary).toList();
    }

    @Transactional(readOnly = true)
    public AgentDtos.Detail get(String id) {
        return toDetail(require(id));
    }

    @Transactional
    public AgentDtos.Detail create(AgentDtos.SaveRequest request) {
        String graphJson = normalize(request.graph());
        Agent agent = new Agent(UUID.randomUUID().toString(), request.name(), request.description(),
                graphJson, GraphValidator.SUPPORTED_SCHEMA_VERSION, Timestamps.now());
        return toDetail(save(agent));
    }

    @Transactional
    public AgentDtos.Detail update(String id, AgentDtos.SaveRequest request) {
        Agent agent = require(id);
        String graphJson = normalize(request.graph());
        agent.update(request.name(), request.description(), graphJson,
                GraphValidator.SUPPORTED_SCHEMA_VERSION, Timestamps.now());
        return toDetail(save(agent));
    }

    @Transactional
    public void delete(String id) {
        Agent agent = require(id);
        repo.delete(agent);
    }

    @Transactional(readOnly = true)
    public Agent require(String id) {
        return repo.findById(id).orElseThrow(() -> ApiException.notFound("agent", id));
    }

    private Agent save(Agent agent) {
        try {
            return repo.saveAndFlush(agent);
        } catch (DataIntegrityViolationException e) {
            throw ApiException.conflict("已存在同名 agent: " + agent.getName());
        }
    }

    /** 校验 + 规范化：graph 以规范化后的 JSON 文本入库，读回时 JsonNode 语义相等。 */
    private String normalize(JsonNode graph) {
        List<Map<String, Object>> problems = GraphValidator.validate(graph);
        if (!problems.isEmpty()) {
            throw ApiException.invalidGraph("图校验失败，共 " + problems.size() + " 个问题", problems);
        }
        try {
            return mapper.writeValueAsString(graph);
        } catch (JsonProcessingException e) {
            throw ApiException.invalidGraph("graph 无法序列化", List.of());
        }
    }

    private AgentDtos.Summary toSummary(Agent agent) {
        return new AgentDtos.Summary(agent.getId(), agent.getName(), agent.getDescription(),
                agent.getGraphSchemaVersion(), nodeCount(agent.getGraphJson()),
                agent.getCreatedAt(), agent.getUpdatedAt());
    }

    private AgentDtos.Detail toDetail(Agent agent) {
        return new AgentDtos.Detail(agent.getId(), agent.getName(), agent.getDescription(),
                agent.getGraphSchemaVersion(), readTree(agent.getGraphJson()),
                agent.getCreatedAt(), agent.getUpdatedAt());
    }

    private JsonNode readTree(String json) {
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("库里存了非法 JSON", e);
        }
    }

    private int nodeCount(String graphJson) {
        JsonNode nodes = readTree(graphJson).get("nodes");
        return nodes == null || !nodes.isArray() ? 0 : nodes.size();
    }
}
