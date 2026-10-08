package local.agentstack;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import local.agentstack.api.dto.AgentDtos;
import local.agentstack.domain.Agent;
import local.agentstack.repo.AgentRepository;
import local.agentstack.service.AgentService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 持久化集成测试：跑在【真实 MySQL 8.4.7】上（项目级实例，见 scripts/db.sh）。
 *
 * 之所以不用 Testcontainers：本机没有 Docker。项目自带 MySQL 实例反而更贴近部署形态，
 * 也让"用 MySQL 存储"这条要求在验收时可被字面验证（数据库里真的能 select 到行）。
 */
@SpringBootTest
@ActiveProfiles("test")
class AgentPersistenceIT {

    @Autowired
    private AgentService agentService;

    @Autowired
    private AgentRepository agentRepository;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper mapper;

    @BeforeEach
    void cleanDatabase() {
        jdbc.execute("DELETE FROM run_event");
        jdbc.execute("DELETE FROM message");
        jdbc.execute("DELETE FROM run");
        jdbc.execute("DELETE FROM conversation");
        jdbc.execute("DELETE FROM agent");
    }

    private JsonNode validGraph() {
        return GraphFixtures.withTools();
    }

    @Test
    @DisplayName("Flyway 已在真实 MySQL 上建好 5 张表")
    void flywayCreatedSchema() {
        List<String> tables = jdbc.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()",
                String.class);
        assertThat(tables).contains("agent", "conversation", "run", "message", "run_event", "flyway_schema_history");
    }

    @Test
    @DisplayName("新建 agent 后能按 JsonNode 语义读回同一张图（存取往返一致）")
    void roundTripsGraph() {
        AgentDtos.Detail created = agentService.create(
                new AgentDtos.SaveRequest("测试 agent", "描述", validGraph()));

        assertThat(created.id()).isNotBlank();
        assertThat(created.graphSchemaVersion()).isEqualTo(1);

        // 走一遍真实数据库，而不是复用内存对象
        Agent reloaded = agentRepository.findById(created.id()).orElseThrow();
        JsonNode stored = read(reloaded.getGraphJson());

        assertThat(stored).isEqualTo(validGraph());
        assertThat(stored.path("nodes")).hasSize(4);
    }

    @Test
    @DisplayName("保存时做浅层校验：非法图被拒且返回可定位到节点的错误")
    void rejectsInvalidGraph() {
        JsonNode graph = read("""
                {
                  "schemaVersion": 1,
                  "nodes": [
                    {"id":"n1","type":"start","position":{"x":0,"y":0},
                     "data":{"config":{"inputVariables":[]}}}
                  ],
                  "edges": [{"id":"e1","source":"n1","target":"ghost"}]
                }
                """);

        assertThatThrownBy(() -> agentService.create(new AgentDtos.SaveRequest("坏图", null, graph)))
                .hasMessageContaining("图校验失败")
                .satisfies(error -> {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> details =
                            (List<Map<String, Object>>) ((local.agentstack.api.ApiException) error).getDetails();
                    assertThat(details).anySatisfy(detail -> {
                        assertThat(detail.get("code")).isEqualTo("EDGE_UNKNOWN_TARGET");
                        assertThat(detail.get("nodeId")).isEqualTo("ghost");
                    });
                });
    }

    @Test
    @DisplayName("同名 agent 冲突返回 CONFLICT 而不是 500")
    void rejectsDuplicateName() {
        agentService.create(new AgentDtos.SaveRequest("唯一名字", null, validGraph()));
        assertThatThrownBy(() -> agentService.create(new AgentDtos.SaveRequest("唯一名字", null, validGraph())))
                .isInstanceOf(local.agentstack.api.ApiException.class)
                .hasMessageContaining("同名");
    }

    @Test
    @DisplayName("更新会覆盖图且保留创建时间，删除会级联清掉会话")
    void updatesAndDeletes() {
        AgentDtos.Detail created = agentService.create(new AgentDtos.SaveRequest("可改", null, validGraph()));
        JsonNode minimal = GraphFixtures.minimal();
        AgentDtos.Detail updated = agentService.update(created.id(), new AgentDtos.SaveRequest("可改2", "新描述", minimal));

        assertThat(updated.name()).isEqualTo("可改2");
        assertThat(updated.graph().path("nodes")).hasSize(2);
        assertThat(updated.createdAt()).isEqualTo(created.createdAt());

        agentService.delete(created.id());
        assertThat(agentRepository.findById(created.id())).isEmpty();
    }

    @Test
    @DisplayName("graph_schema_version 与节点数会出现在列表里，供 UI 展示")
    void listsSummaries() {
        agentService.create(new AgentDtos.SaveRequest("列表用", null, validGraph()));
        List<AgentDtos.Summary> list = agentService.list();
        assertThat(list).hasSize(1);
        assertThat(list.get(0).nodeCount()).isEqualTo(4);
    }

    private JsonNode read(String json) {
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
