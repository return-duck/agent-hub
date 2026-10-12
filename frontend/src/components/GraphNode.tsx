import { Handle, Position, type NodeProps } from '@xyflow/react';
import { nodeSpec } from '../manifest.js';
import { useStudio, type AgentNode } from '../store/studioStore.js';

const STATUS_TEXT: Record<string, string> = {
  idle: '',
  running: '运行中',
  ok: '完成',
  error: '出错',
};

/**
 * 画布节点。运行状态直接从 store 的 nodeState 取 —— 事件驱动高亮，
 * 组件本身不做任何状态迁移。
 */
export function GraphNode({ id, data, type, selected }: NodeProps<AgentNode>) {
  const spec = nodeSpec(type ?? '');
  const status = useStudio((s) => s.run.nodeState[id] ?? 'idle');

  const resolved = spec ?? { displayName: '', maxIncoming: 1, maxOutgoing: 1 };
  const incoming = resolved.maxIncoming !== 0;
  const outgoing = resolved.maxOutgoing !== 0;

  return (
    <div className={`graph-node status-${status} ${selected ? 'selected' : ''}`}>
      {incoming && <Handle type="target" position={Position.Left} />}
      <div className="graph-node__title">
        <span>{data.label}</span>
        {status !== 'idle' && <span className={`dot dot-${status}`} title={STATUS_TEXT[status]} />}
      </div>
      <div className="graph-node__body">{summaryOf(data)}</div>
      {outgoing && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

function summaryOf(data: AgentNode['data']): string {
  const config = data.config ?? {};
  const url = textOf(config['url']);
  if (url) return truncate(url);
  const source = textOf(config['source']);
  if (source) return truncate(source);
  const prompt = textOf(config['prompt']);
  if (prompt) return truncate(prompt);
  const template = textOf(config['template']);
  if (template) return truncate(template);
  const system = textOf(config['system']);
  if (system) return truncate(system);
  if (Array.isArray(config['tools']) && config['tools'].length > 0) {
    return `工具: ${(config['tools'] as string[]).join(', ')}`;
  }
  if (Array.isArray(config['inputVariables']) && config['inputVariables'].length > 0) {
    return (config['inputVariables'] as Array<{ name?: string }>)
      .map((v) => v.name)
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { mode?: unknown; value?: unknown; ref?: unknown };
    if (record.mode === 'ref' && typeof record.ref === 'string') return record.ref;
    if (typeof record.value === 'string') return record.value;
  }
  return '';
}

function truncate(text: string): string {
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}
