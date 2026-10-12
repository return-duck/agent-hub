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

import java.security.SecureRandom;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * agent 的增删改查与发布。
 *
 * 归属是硬边界：所有读写方法都带 userId，非本人一律按"不存在"处理（404 而不是 403），
 * 这样接口不会被用来枚举别人有哪些 agent。
 */
@Service
public class AgentService {

    /** 公开链接用的字母表：刻意去掉 0/O/1/l/I 这类易混字符，方便口头/手抄传播。 */
    private static final char[] SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz".toCharArray();
    private static final int SLUG_LENGTH = 12;
    private static final int SLUG_MAX_ATTEMPTS = 8;

    private final AgentRepository repo;
    private final ObjectMapper mapper;
    private final SecureRandom random = new SecureRandom();

    public AgentService(AgentRepository repo, ObjectMapper mapper) {
        this.repo = repo;
        this.mapper = mapper;
    }

    @Transactional(readOnly = true)
    public List<AgentDtos.Summary> list(String ownerId) {
        return repo.findByOwnerIdOrderByUpdatedAtDesc(ownerId).stream().map(this::toSummary).toList();
    }

    @Transactional(readOnly = true)
    public AgentDtos.Detail get(String id, String ownerId) {
        return toDetail(require(id, ownerId));
    }

    @Transactional
    public AgentDtos.Detail create(String ownerId, AgentDtos.SaveRequest request) {
        String graphJson = normalize(request.graph());
        Agent agent = new Agent(UUID.randomUUID().toString(), ownerId, request.name(), request.description(),
                graphJson, GraphValidator.SUPPORTED_SCHEMA_VERSION, Timestamps.now());
        return toDetail(save(agent));
    }

    @Transactional
    public AgentDtos.Detail update(String id, String ownerId, AgentDtos.SaveRequest request) {
        Agent agent = require(id, ownerId);
        String graphJson = normalize(request.graph());
        agent.update(request.name(), request.description(), graphJson,
                GraphValidator.SUPPORTED_SCHEMA_VERSION, Timestamps.now());
        return toDetail(save(agent));
    }

    @Transactional
    public void delete(String id, String ownerId) {
        repo.delete(require(id, ownerId));
    }

    /**
     * 发布：生成公开 slug 并置为已发布。重复调用是幂等的 ——
     * 已有 slug 时复用它，避免用户每点一次"发布"链接就变一次。
     */
    @Transactional
    public AgentDtos.PublishResult publish(String id, String ownerId) {
        Agent agent = require(id, ownerId);
        String slug = agent.getPublicSlug();
        if (slug == null || slug.isBlank()) {
            slug = allocateSlug();
        }
        agent.publish(slug, Timestamps.now());
        repo.saveAndFlush(agent);
        return new AgentDtos.PublishResult(slug, publicPath(slug), true);
    }

    @Transactional
    public AgentDtos.PublishResult unpublish(String id, String ownerId) {
        Agent agent = require(id, ownerId);
        agent.unpublish();
        repo.saveAndFlush(agent);
        String slug = agent.getPublicSlug();
        return new AgentDtos.PublishResult(slug, slug == null ? null : publicPath(slug), false);
    }

    public static String publicPath(String slug) {
        return "/a/" + slug;
    }

    @Transactional(readOnly = true)
    public Agent require(String id, String ownerId) {
        Agent agent = repo.findById(id).orElseThrow(() -> ApiException.notFound("agent", id));
        if (agent.getOwnerId() == null || !agent.getOwnerId().equals(ownerId)) {
            // 别人的 agent 一律当作不存在，避免被用来探测
            throw ApiException.notFound("agent", id);
        }
        return agent;
    }

    /** 公开页面按 slug 取：必须处于已发布状态。 */
    @Transactional(readOnly = true)
    public Agent requirePublic(String slug) {
        return repo.findByPublicSlugAndPublishedTrue(slug)
                .orElseThrow(() -> ApiException.notFound("已发布的 agent", slug));
    }

    private String allocateSlug() {
        for (int attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
            StringBuilder sb = new StringBuilder(SLUG_LENGTH);
            for (int i = 0; i < SLUG_LENGTH; i++) {
                sb.append(SLUG_ALPHABET[random.nextInt(SLUG_ALPHABET.length)]);
            }
            String candidate = sb.toString();
            if (!repo.existsByPublicSlug(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("生成公开链接标识失败，请重试");
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
                agent.isPublished(), agent.getPublicSlug(), agent.getCreatedAt(), agent.getUpdatedAt());
    }

    private AgentDtos.Detail toDetail(Agent agent) {
        return new AgentDtos.Detail(agent.getId(), agent.getName(), agent.getDescription(),
                agent.getGraphSchemaVersion(), readTree(agent.getGraphJson()),
                agent.isPublished(), agent.getPublicSlug(), agent.getPublishedAt(),
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
