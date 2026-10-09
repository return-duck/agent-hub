-- V2：用户体系 + agent 归属与发布 + 访客会话
--
-- 设计说明：
--  1) 密码用 JDK 自带的 PBKDF2WithHmacSHA256（不需要引入 spring-security），
--     存 hash + salt 两列；校验用常量时间比较。
--  2) 会话令牌不存明文：库里只存 SHA-256(token)，即使库被读走也无法冒充登录。
--     令牌是"不透明随机串"而不是 JWT —— 可以随时吊销，也不需要额外依赖。
--  3) agent.owner_id 允许 NULL：V1 时代建的 agent 没有归属（部署时的验证数据），
--     迁移不删数据，它们只是不再出现在任何用户的列表里。
--  4) public_slug 单独建唯一索引；未发布的 agent 该列为 NULL，
--     而 MySQL 唯一索引允许多个 NULL，所以未发布之间不会互相冲突。
--  5) V1 的 uk_agent_name 是全局唯一，与"每个用户各自有同名 agent"冲突，
--     这里换成 (owner_id, name) 唯一。

CREATE TABLE app_user (
  id            VARCHAR(36)  NOT NULL,
  email         VARCHAR(190) NOT NULL,
  display_name  VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_salt VARCHAR(64)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_app_user_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE user_session (
  token_hash CHAR(64)    NOT NULL,
  user_id    VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_user_session_user (user_id),
  KEY idx_user_session_expires (expires_at),
  CONSTRAINT fk_user_session_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

ALTER TABLE agent
  ADD COLUMN owner_id     VARCHAR(36)  NULL AFTER id,
  ADD COLUMN published    TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN public_slug  VARCHAR(64)  NULL,
  ADD COLUMN published_at DATETIME(3)  NULL;

ALTER TABLE agent DROP INDEX uk_agent_name;
ALTER TABLE agent ADD UNIQUE KEY uk_agent_slug (public_slug);
ALTER TABLE agent ADD UNIQUE KEY uk_agent_owner_name (owner_id, name);
ALTER TABLE agent ADD KEY idx_agent_owner (owner_id, updated_at);
ALTER TABLE agent ADD CONSTRAINT fk_agent_owner
  FOREIGN KEY (owner_id) REFERENCES app_user (id) ON DELETE CASCADE;

-- 访客：公开页面的对话按 visitor_id 隔离，避免一个访客读到别人的会话记录
ALTER TABLE conversation
  ADD COLUMN visitor_id VARCHAR(64) NULL AFTER agent_id,
  ADD KEY idx_conversation_visitor (agent_id, visitor_id, created_at);
