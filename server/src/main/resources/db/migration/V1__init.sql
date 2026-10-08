-- Agent Stack 持久化 V1：5 张表。
--
-- 设计说明（刻意的取舍）：
--  1) graph_json / payload_json 用 LONGTEXT 而不是 MySQL JSON 列：
--     服务层需要返回带 nodeId 的结构化校验错误，规范化与校验都集中在这一层；
--     用文本列可以避免 MySQL JSON 列在键序/空白上的额外规范化与跨库方言差异。
--     往返一致性由集成测试断言（JsonNode 语义相等）。
--  2) run_event 是 append-only 的事件真源，(run_id, seq) 唯一约束让 SSE 续传天然可判重。
--  3) 表数量克制：agent_version / checkpoint / interrupt / tool_invocation / llm_usage /
--     credential 都属于 Phase 2，见 docs/DESIGN.md 的"明确不做"。

CREATE TABLE agent (
  id                   VARCHAR(36)  NOT NULL,
  name                 VARCHAR(128) NOT NULL,
  description          VARCHAR(512) NULL,
  graph_json           LONGTEXT     NOT NULL,
  graph_schema_version INT          NOT NULL DEFAULT 1,
  created_at           DATETIME(3)  NOT NULL,
  updated_at           DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agent_name (name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE conversation (
  id         VARCHAR(36)  NOT NULL,
  agent_id   VARCHAR(36)  NOT NULL,
  title      VARCHAR(255) NULL,
  created_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_conversation_agent (agent_id, created_at),
  CONSTRAINT fk_conversation_agent FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE run (
  id              VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL,
  agent_id        VARCHAR(36) NOT NULL,
  status          VARCHAR(16) NOT NULL,
  input_json      LONGTEXT    NULL,
  answer          LONGTEXT    NULL,
  error_json      LONGTEXT    NULL,
  started_at      DATETIME(3) NOT NULL,
  finished_at     DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_run_conversation (conversation_id, started_at),
  CONSTRAINT fk_run_conversation FOREIGN KEY (conversation_id) REFERENCES conversation (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE message (
  id              VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL,
  run_id          VARCHAR(36) NULL,
  seq             INT         NOT NULL,
  role            VARCHAR(16) NOT NULL,
  content         LONGTEXT    NULL,
  tool_calls_json LONGTEXT    NULL,
  created_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_message_seq (conversation_id, seq),
  KEY idx_message_run (run_id),
  CONSTRAINT fk_message_conversation FOREIGN KEY (conversation_id) REFERENCES conversation (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE run_event (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  run_id       VARCHAR(36)  NOT NULL,
  seq          INT          NOT NULL,
  type         VARCHAR(48)  NOT NULL,
  node_id      VARCHAR(64)  NULL,
  payload_json LONGTEXT     NOT NULL,
  created_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_run_event_seq (run_id, seq),
  CONSTRAINT fk_run_event_run FOREIGN KEY (run_id) REFERENCES run (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
