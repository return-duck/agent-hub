-- V3：中断对话 / 断点重试 / 调用轨迹（持久化）
--
-- 设计说明：
--  1) trace_span 是「调用轨迹」的持久化真源。一次 run 里的每个可观测动作都是一条 span：
--     node（画布节点）、model（一次模型调用，含输入输出）、
--     tool / mcp / skill（一次工具类调用，按类别区分）。
--     刻意做成通用 span 模型而不是"给每种调用建一张表"：将来接入 MCP 或技能包时
--     不需要改表结构，换 kind 枚举值即可。
--  2) span 在**结束时**才写入（此时才有 duration 与结果），但对外的 span_seq 在
--     开始时就分配，因此顺序仍然反映真实发生顺序。
--  3) 与 run 的外键带 ON DELETE CASCADE：会话回退（rewind）删掉 run 时，
--     它的轨迹也一起消失，不会留下指向已删 run 的孤儿记录。
--  4) 长文本（模型输入输出、工具结果）用 LONGTEXT：轨迹的价值就在于事后能看到原文，
--     截断策略在写入前做（见 TraceRecorder），库里存的就是最终形态。

ALTER TABLE run
  ADD COLUMN retry_of_run_id VARCHAR(36) NULL AFTER agent_id,
  ADD KEY idx_run_retry_of (retry_of_run_id);

CREATE TABLE trace_span (
  id              VARCHAR(36)  NOT NULL,
  run_id          VARCHAR(36)  NOT NULL,
  conversation_id VARCHAR(36)  NOT NULL,
  agent_id        VARCHAR(36)  NOT NULL,
  span_seq        INT          NOT NULL,
  kind            VARCHAR(16)  NOT NULL,
  name            VARCHAR(160) NOT NULL,
  node_id         VARCHAR(64)  NULL,
  status          VARCHAR(16)  NOT NULL,
  started_at      DATETIME(3)  NOT NULL,
  ended_at        DATETIME(3)  NULL,
  duration_ms     INT          NULL,
  input_json      LONGTEXT     NULL,
  output_json     LONGTEXT     NULL,
  attributes_json LONGTEXT     NULL,
  error_text      VARCHAR(1024) NULL,
  created_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_trace_run_seq (run_id, span_seq),
  KEY idx_trace_agent_time (agent_id, started_at),
  KEY idx_trace_conversation (conversation_id, started_at),
  CONSTRAINT fk_trace_span_run FOREIGN KEY (run_id) REFERENCES run (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
