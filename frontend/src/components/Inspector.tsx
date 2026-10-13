import { Button, Checkbox, Empty, Input, InputNumber, Select, Tag, Typography } from 'antd';
import { useStudio, type AgentNode } from '../store/studioStore.js';
import { nodeSpec, toolNames } from '../manifest.js';
import type { JsonSchemaProperty, OutputPortSpec, VariableDecl } from '../generated/manifest.js';
import { outputGroups, type BindingType, type OutputGroup, type PortType } from '../ports.js';

/**
 * 节点配置面板：表单 100% 由 manifest 的 configSchema + uiSchema 生成。
 * 这里没有一处 `if (nodeType === 'llm')` —— 新增节点类型时这个文件不需要改。
 */
export function Inspector() {
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const updateNodeConfig = useStudio((s) => s.updateNodeConfig);
  const setLabel = useStudio((s) => s.setLabel);
  const removeNode = useStudio((s) => s.removeNode);

  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) {
    return (
      <Empty description="选中画布上的节点来编辑它的配置。左侧点节点类型即可添加到画布。" />
    );
  }

  const spec = nodeSpec(node.type ?? '');
  const uiSchema = (spec?.uiSchema ?? {}) as Record<string, UiHint>;
  const properties = (spec?.configSchema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const config = node.data.config ?? {};

  return (
    <div className="inspector">
      <div className="inspector__head">
        <Tag>{spec?.displayName ?? node.type}</Tag>
        <Typography.Text type="secondary" code>{node.id}</Typography.Text>
      </div>

      <div className="field">
        <span className="field__label">节点名称</span>
        <Input value={node.data.label} onChange={(event) => setLabel(node.id, event.target.value)} />
      </div>

      {spec?.description && <Typography.Paragraph type="secondary">{spec.description}</Typography.Paragraph>}

      {Object.entries(properties).map(([key, property]) => {
        const ui = uiSchema[key];
        if (ui?.widget === 'hidden') return null;
        return (
          <Field
            key={key}
            name={key}
            property={property}
            ui={ui}
            value={config[key]}
            nodes={nodes}
            edges={edges}
            nodeId={node.id}
            onChange={(value) => updateNodeConfig(node.id, { [key]: value })}
          />
        );
      })}

      {spec?.outputs && !properties['outputs'] && <ReadOnlyOutputs outputs={spec.outputs} />}

      <Button danger block onClick={() => removeNode(node.id)}>
        删除该节点
      </Button>
    </div>
  );
}

interface UiHint {
  widget?: string;
  placeholder?: string;
  valueType?: BindingType;
  multiline?: boolean;
  label?: string;
  columns?: Array<'name' | 'type' | 'description' | 'required' | 'value'>;
  valueMode?: 'none' | 'ref' | 'custom';
  template?: 'brace';
}

interface FieldProps {
  name: string;
  property: JsonSchemaProperty;
  ui?: UiHint;
  value: unknown;
  nodes: AgentNode[];
  edges: Array<{ source: string; target: string }>;
  nodeId: string;
  onChange: (value: unknown) => void;
}

function Field({ name, property, ui, value, nodes, edges, nodeId, onChange }: FieldProps) {
  const label = ui?.label || name;

  if (ui?.widget === 'hidden') return null;

  if (ui?.widget === 'model') {
    return <ModelField label={label} value={value} onChange={onChange} />;
  }

  if (ui?.widget === 'paramTable') {
    return (
      <ParamTable
        label={label}
        columns={ui.columns ?? ['name', 'type', 'value']}
        valueMode={ui.valueMode ?? 'custom'}
        value={value}
        nodes={nodes}
        edges={edges}
        nodeId={nodeId}
        onChange={onChange}
      />
    );
  }

  if (ui?.widget === 'binding') {
    return (
      <BindingField
        label={label}
        accept={ui.valueType ?? 'string'}
        multiline={ui.multiline}
        placeholder={ui.placeholder}
        value={value}
        nodes={nodes}
        edges={edges}
        nodeId={nodeId}
        onChange={onChange}
      />
    );
  }

  if (ui?.widget === 'bindingList') {
    return (
      <BindingListField label={label} value={value} nodes={nodes} edges={edges} nodeId={nodeId} onChange={onChange} />
    );
  }

  if (ui?.widget === 'variableList') {
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <VariableListEditor
          variables={Array.isArray(value) ? (value as VariableDecl[]) : []}
          onChange={onChange}
        />
      </div>
    );
  }

  if (property.type === 'array' && property.items?.enum) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          value={selected}
          options={(property.items.enum ?? []).map((option) => ({ value: option, label: option }))}
          onChange={(next) => onChange(next)}
        />
        {selected.length === 0 && (
          <p className="hint">
            未绑定工具：该模型节点只做一次调用。绑定工具后会编译成 ReAct 循环（model → tools → model）。
          </p>
        )}
      </div>
    );
  }

  if (property.enum) {
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <Select
          style={{ width: '100%' }}
          value={String(value ?? property.default ?? '')}
          options={property.enum.map((option) => ({ value: option, label: option }))}
          onChange={(next) => onChange(next)}
        />
      </label>
    );
  }

  if (property.type === 'number' || property.type === 'integer') {
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <InputNumber
          style={{ width: '100%' }}
          min={property.minimum}
          max={property.maximum}
          value={value === undefined || value === null || value === '' ? null : Number(value)}
          onChange={(next) => onChange(next ?? undefined)}
        />
      </label>
    );
  }

  if (ui?.widget === 'textarea') {
    const binding = readBinding(value);
    const text = typeof value === 'string' ? value : String(binding.value ?? '');
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <Input.TextArea
          rows={ui.template === 'brace' ? 6 : 8}
          placeholder={ui.placeholder}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
        {ui.template === 'brace' && (
          <p className="hint">用 {'{参数名}'} 引用上面入参表里的名字，例如 {'{topic}'}。运行时替换成对应文本。</p>
        )}
      </label>
    );
  }

  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <Input
        placeholder={ui?.placeholder}
        value={String(value ?? property.default ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface BindingValue {
  mode: 'custom' | 'ref';
  value: unknown;
  ref: string;
}

function readBinding(raw: unknown): BindingValue {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as { mode?: unknown; value?: unknown; ref?: unknown };
    const ref = typeof record.ref === 'string' ? record.ref : '';
    if (record.mode === 'ref') return { mode: 'ref', value: record.value ?? '', ref };
    if (record.mode === 'custom' || 'value' in record || 'ref' in record) {
      return { mode: 'custom', value: record.value ?? '', ref };
    }
  }
  return { mode: 'custom', value: raw ?? '', ref: '' };
}

function BindingField({
  label,
  accept,
  multiline,
  placeholder,
  value,
  nodes,
  edges,
  nodeId,
  onChange,
}: {
  label: string;
  accept: BindingType;
  multiline?: boolean;
  placeholder?: string;
  value: unknown;
  nodes: AgentNode[];
  edges: Array<{ source: string; target: string }>;
  nodeId: string;
  onChange: (value: unknown) => void;
}) {
  const binding = readBinding(value);

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <GroupedRefSelect
        accept={accept}
        nodes={nodes}
        edges={edges}
        nodeId={nodeId}
        refValue={binding.mode === 'ref' ? binding.ref : ''}
        allowEmpty
        emptyLabel="自定义"
        onChange={(ref) =>
          onChange(ref ? { mode: 'ref', ref, value: binding.value } : { mode: 'custom', ref: '', value: binding.value })
        }
      />
      {binding.mode !== 'ref' && (
        <LiteralInput
          type={accept}
          multiline={multiline}
          placeholder={placeholder}
          value={binding.value}
          onChange={(next) => onChange({ mode: 'custom', ref: '', value: next })}
        />
      )}
      <p className="hint">
        {accept === 'any' ? '可以选择任意上游输出，或不选而自己填写。' : `只列出类型为 ${accept} 的输出；不选则自己填写。`}
      </p>
    </div>
  );
}

function BindingListField({
  label,
  value,
  nodes,
  edges,
  nodeId,
  onChange,
}: {
  label: string;
  value: unknown;
  nodes: AgentNode[];
  edges: Array<{ source: string; target: string }>;
  nodeId: string;
  onChange: (value: unknown) => void;
}) {
  if (typeof value === 'string') {
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <Input.TextArea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
        <Button size="small" onClick={() => onChange([])}>
          改用下拉选择
        </Button>
        <p className="hint">这是旧的 name=input.x 写法。改用下拉后，每一项都可以按类型选择上游输出。</p>
      </div>
    );
  }

  const rows = Array.isArray(value) ? value : [];
  const update = (index: number, patch: Record<string, unknown>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...(row as object), ...patch } : row)));
  };

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="binding-list">
        {rows.map((raw, index) => {
          const row = readBinding(raw);
          const record = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; type?: unknown };
          const name = typeof record.name === 'string' ? record.name : '';
          const type: PortType = isPortType(record.type) ? record.type : 'string';
          return (
            <div className="binding-row" key={index}>
              <div className="binding-row__head">
                <Input
                  placeholder="输入名，如 query"
                  value={name}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
                <Select
                  value={type}
                  options={PORT_TYPE_OPTIONS}
                  onChange={(next) => update(index, { type: next, mode: 'custom', ref: '', value: '' })}
                />
                <Button size="small" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                  ×
                </Button>
              </div>
              <GroupedRefSelect
                accept={type}
                nodes={nodes}
                edges={edges}
                nodeId={nodeId}
                refValue={row.mode === 'ref' ? row.ref : ''}
                allowEmpty
                emptyLabel="自定义"
                onChange={(ref) => update(index, ref ? { mode: 'ref', ref } : { mode: 'custom', ref: '' })}
              />
              {row.mode !== 'ref' && (
                <LiteralInput
                  type={type}
                  multiline={type === 'string' || type === 'object'}
                  placeholder={type === 'object' ? '{"k":1}' : ''}
                  value={row.value}
                  onChange={(next) => update(index, { mode: 'custom', ref: '', value: next })}
                />
              )}
            </div>
          );
        })}
      </div>
      <Button size="small" onClick={() => onChange([...rows, { name: '', type: 'string', mode: 'custom', value: '', ref: '' }])}>
        + 添加输入
      </Button>
      <p className="hint">每一项只列出类型相同的上游输出。不选则填写自定义值。代码里用 inputs.名字 读取。</p>
    </div>
  );
}

function LiteralInput({
  type,
  multiline,
  placeholder,
  value,
  onChange,
}: {
  type: BindingType;
  multiline?: boolean;
  placeholder?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (type === 'boolean') {
    const current = value === true || value === 'true' ? 'true' : 'false';
    return (
      <Select
        style={{ width: '100%' }}
        value={current}
        options={[
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
        ]}
        onChange={(next) => onChange(next === 'true')}
      />
    );
  }
  if (type === 'number') {
    return (
      <InputNumber
        style={{ width: '100%' }}
        placeholder={placeholder}
        value={value === undefined || value === null || value === '' ? null : Number(value)}
        onChange={(next) => onChange(next ?? '')}
      />
    );
  }
  if (multiline || type === 'object') {
    const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    return (
      <Input.TextArea
        rows={4}
        placeholder={placeholder}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Input
      placeholder={placeholder}
      value={value == null ? '' : String(value)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

const PORT_TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'object', label: 'object' },
];

function isPortType(value: unknown): value is PortType {
  return value === 'string' || value === 'number' || value === 'boolean' || value === 'object';
}

function GroupedRefSelect({
  accept,
  nodes,
  edges,
  nodeId,
  refValue,
  allowEmpty,
  emptyLabel,
  onChange,
}: {
  accept: BindingType;
  nodes: AgentNode[];
  edges: Array<{ source: string; target: string }>;
  nodeId: string;
  refValue: string;
  allowEmpty: boolean;
  emptyLabel: string;
  onChange: (ref: string, type?: PortType) => void;
}) {
  const groups: OutputGroup[] = outputGroups(nodes, edges, nodeId, accept);
  const known = groups.some((group) => group.choices.some((choice) => choice.ref === refValue));
  const options = [
    ...(allowEmpty || !refValue ? [{ value: '', label: allowEmpty ? emptyLabel : '选择字段' }] : []),
    ...(refValue && !known ? [{ value: refValue, label: `${refValue}（已删除或类型不符）` }] : []),
    ...groups.map((group) => ({
      label: group.title,
      options: group.choices.map((choice) => ({ value: choice.ref, label: choice.label })),
    })),
  ];
  return (
    <Select
      style={{ width: '100%' }}
      value={refValue}
      options={options}
      onChange={(ref) => {
        const choice = groups.flatMap((group) => group.choices).find((item) => item.ref === ref);
        onChange(ref, choice?.type);
      }}
    />
  );
}

function ModelField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const capabilities = useStudio((s) => s.capabilities);
  const current = capabilities?.modelName ?? '';
  const stored = typeof value === 'string' ? value : '';
  const selected = stored || current;
  const options = [...new Set([current, stored].filter((item) => item.length > 0))];
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <Select
        style={{ width: '100%' }}
        value={selected || undefined}
        placeholder="当前运行时模型"
        options={options.map((option) => ({ value: option, label: option }))}
        onChange={(next) => onChange(next)}
      />
      <p className="hint">选项来自当前运行时可用的模型。这次运行调用的就是这个进程里配置好的模型。</p>
    </label>
  );
}

function ReadOnlyOutputs({ outputs }: { outputs: readonly OutputPortSpec[] }) {
  return (
    <div className="field">
      <span className="field__label">出参</span>
      <div className="param-table">
        <div className="param-table__head">
          <span>参数名</span>
          <span>类型</span>
          <span>描述</span>
        </div>
        {outputs.map((output) => (
          <div className="param-table__row" key={output.name}>
            <Input value={output.name} readOnly />
            <Input value={output.type} readOnly />
            <Input value={output.label ?? ''} readOnly />
          </div>
        ))}
      </div>
    </div>
  );
}

type ParamColumn = 'name' | 'type' | 'description' | 'required' | 'value';

function ParamTable({
  label,
  columns,
  valueMode,
  value,
  nodes,
  edges,
  nodeId,
  onChange,
}: {
  label: string;
  columns: ParamColumn[];
  valueMode: 'none' | 'ref' | 'custom';
  value: unknown;
  nodes: AgentNode[];
  edges: Array<{ source: string; target: string }>;
  nodeId: string;
  onChange: (value: unknown) => void;
}) {
  if (typeof value === 'string') {
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <Input.TextArea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
        <Button size="small" onClick={() => onChange([])}>
          改用参数表
        </Button>
        <p className="hint">这是旧的 name=input.x 写法。改用参数表后，每一项都可以选择上游字段。</p>
      </div>
    );
  }

  const rows = Array.isArray(value) ? value : [];
  const update = (index: number, patch: Record<string, unknown>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...(row as object), ...patch } : row)));
  };
  const move = (index: number, direction: -1 | 1): void => {
    const next = index + direction;
    if (next < 0 || next >= rows.length) return;
    const copy = [...rows];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onChange(copy);
  };

  return (
    <div className="field">
      <div className="param-table__title">
        <span className="field__label">{label}</span>
        <Button size="small" onClick={() => onChange([...rows, blankRow(columns, valueMode)])}>
          +
        </Button>
      </div>
      <div className="param-table">
        <div className="param-table__head" style={{ gridTemplateColumns: gridOf(columns) }}>
          {columns.map((column) => (
            <span key={column}>{COLUMN_LABEL[column]}</span>
          ))}
          <span>操作</span>
        </div>
        {rows.map((raw, index) => {
          const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const binding = readBinding(raw);
          const type: PortType = isPortType(record['type']) ? record['type'] : 'string';
          return (
            <div className="param-table__row" style={{ gridTemplateColumns: gridOf(columns) }} key={index}>
              {columns.map((column) => {
                if (column === 'name') {
                  return (
                    <Input
                      key={column}
                      placeholder="参数名"
                      value={typeof record['name'] === 'string' ? record['name'] : ''}
                      onChange={(event) => update(index, { name: event.target.value })}
                    />
                  );
                }
                if (column === 'type') {
                  return (
                    <Select
                      key={column}
                      value={type}
                      options={PORT_TYPE_OPTIONS}
                      onChange={(next) =>
                        update(index, { type: next, mode: valueMode === 'none' ? undefined : 'custom', ref: '', value: '' })
                      }
                    />
                  );
                }
                if (column === 'description') {
                  return (
                    <Input
                      key={column}
                      placeholder="描述"
                      value={typeof record['description'] === 'string' ? record['description'] : ''}
                      onChange={(event) => update(index, { description: event.target.value })}
                    />
                  );
                }
                if (column === 'required') {
                  return (
                    <Checkbox
                      key={column}
                      checked={record['required'] !== false}
                      onChange={(event) => update(index, { required: event.target.checked })}
                    >
                      必填
                    </Checkbox>
                  );
                }
                return (
                  <div className="param-value" key={column}>
                    <GroupedRefSelect
                      accept={columns.includes('type') ? type : 'any'}
                      nodes={nodes}
                      edges={edges}
                      nodeId={nodeId}
                      refValue={binding.mode === 'ref' ? binding.ref : ''}
                      allowEmpty={valueMode === 'custom'}
                      emptyLabel={valueMode === 'custom' ? '自定义' : '选择字段'}
                      onChange={(ref, picked) => {
                        if (!ref) {
                          update(index, { mode: 'custom', ref: '' });
                          return;
                        }
                        update(index, {
                          mode: 'ref',
                          ref,
                          ...(picked && columns.includes('type') ? { type: picked } : {}),
                        });
                      }}
                    />
                    {valueMode === 'custom' && binding.mode !== 'ref' && (
                      <LiteralInput
                        type={type}
                        multiline={type === 'object'}
                        placeholder={type === 'object' ? '{"k":1}' : ''}
                        value={binding.value}
                        onChange={(next) => update(index, { mode: 'custom', ref: '', value: next })}
                      />
                    )}
                  </div>
                );
              })}
              <div className="param-actions">
                <Button size="small" onClick={() => move(index, -1)} title="上移">
                  ↑
                </Button>
                <Button size="small" onClick={() => move(index, 1)} title="下移">
                  ↓
                </Button>
                <Button size="small" danger onClick={() => onChange(rows.filter((_, i) => i !== index))} title="删除">
                  ×
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const COLUMN_LABEL: Record<ParamColumn, string> = {
  name: '参数名',
  type: '类型',
  description: '描述',
  required: '必填',
  value: '参数值',
};

function gridOf(columns: ParamColumn[]): string {
  const widths = columns.map((column) => (column === 'required' ? '72px' : 'minmax(72px, 1fr)'));
  return `${widths.join(' ')} 92px`;
}

function blankRow(columns: ParamColumn[], valueMode: 'none' | 'ref' | 'custom'): Record<string, unknown> {
  const row: Record<string, unknown> = { name: '' };
  if (columns.includes('type')) row['type'] = 'string';
  if (columns.includes('description')) row['description'] = '';
  if (columns.includes('required')) row['required'] = true;
  if (valueMode === 'ref') {
    row['mode'] = 'ref';
    row['ref'] = '';
  }
  if (valueMode === 'custom') {
    row['mode'] = 'custom';
    row['ref'] = '';
    row['value'] = '';
  }
  return row;
}

function VariableListEditor({
  variables,
  onChange,
}: {
  variables: VariableDecl[];
  onChange: (value: unknown) => void;
}) {
  const update = (index: number, patch: Partial<VariableDecl>): void => {
    onChange(variables.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };

  return (
    <div className="variable-list">
      {variables.map((variable, index) => (
        <div className="variable-row" key={`${variable.name}-${index}`}>
          <Input
            placeholder="变量名，如 topic"
            value={variable.name ?? ''}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <Select
            value={variable.type ?? 'string'}
            options={PORT_TYPE_OPTIONS.filter((option) => option.value !== 'object')}
            onChange={(next) => update(index, { type: next as VariableDecl['type'] })}
          />
          <Checkbox
            checked={variable.required !== false}
            onChange={(event) => update(index, { required: event.target.checked })}
          >
            必填
          </Checkbox>
          <Button size="small" onClick={() => onChange(variables.filter((_, i) => i !== index))}>
            ×
          </Button>
        </div>
      ))}
      <Button size="small" onClick={() => onChange([...variables, { name: '', type: 'string', required: true }])}>
        + 添加变量
      </Button>
      <p className="hint">
        在提示词里用 <code>{'{{input.变量名}}'}</code> 引用；运行时会按类型校验。
        可用工具：{toolNames().join('、')}
      </p>
    </div>
  );
}
