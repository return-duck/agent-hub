import { useStudio, type AgentNode } from '../store/studioStore.js';
import { nodeSpec, toolNames } from '../manifest.js';
import type { JsonSchemaProperty, VariableDecl } from '../generated/manifest.js';
import { outputChoices, type BindingType, type PortType } from '../ports.js';

/**
 * 节点配置面板：表单 100% 由 manifest 的 configSchema + uiSchema 生成。
 * 这里没有一处 `if (nodeType === 'llm')` —— 新增节点类型时这个文件不需要改。
 */
export function Inspector() {
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const nodes = useStudio((s) => s.nodes);
  const updateNodeConfig = useStudio((s) => s.updateNodeConfig);
  const setLabel = useStudio((s) => s.setLabel);
  const removeNode = useStudio((s) => s.removeNode);

  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) {
    return (
      <div className="panel-empty">
        <p>选中画布上的节点来编辑它的配置。</p>
        <p className="muted">左侧点节点类型即可添加到画布。</p>
      </div>
    );
  }

  const spec = nodeSpec(node.type ?? '');
  const uiSchema = (spec?.uiSchema ?? {}) as Record<string, UiHint>;
  const properties = (spec?.configSchema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const config = node.data.config ?? {};

  return (
    <div className="inspector">
      <div className="inspector__head">
        <span className="badge">{spec?.displayName ?? node.type}</span>
        <code className="muted">{node.id}</code>
      </div>

      <label className="field">
        <span className="field__label">节点名称</span>
        <input
          value={node.data.label}
          onChange={(event) => setLabel(node.id, event.target.value)}
        />
      </label>

      {spec?.description && <p className="hint">{spec.description}</p>}

      {Object.entries(properties).map(([key, property]) => (
        <Field
          key={key}
          name={key}
          property={property}
          ui={uiSchema[key]}
          value={config[key]}
          nodes={nodes}
          nodeId={node.id}
          onChange={(value) => updateNodeConfig(node.id, { [key]: value })}
        />
      ))}

      <button className="btn btn-danger btn-block" onClick={() => removeNode(node.id)}>
        删除该节点
      </button>
    </div>
  );
}

interface UiHint {
  widget?: string;
  placeholder?: string;
  valueType?: BindingType;
  multiline?: boolean;
  label?: string;
}

interface FieldProps {
  name: string;
  property: JsonSchemaProperty;
  ui?: UiHint;
  value: unknown;
  nodes: AgentNode[];
  nodeId: string;
  onChange: (value: unknown) => void;
}

function Field({ name, property, ui, value, nodes, nodeId, onChange }: FieldProps) {
  const label = ui?.label || name;

  if (ui?.widget === 'binding') {
    return (
      <BindingField
        label={label}
        accept={ui.valueType ?? 'string'}
        multiline={ui.multiline}
        placeholder={ui.placeholder}
        value={value}
        nodes={nodes}
        nodeId={nodeId}
        onChange={onChange}
      />
    );
  }

  if (ui?.widget === 'bindingList') {
    return <BindingListField label={label} value={value} nodes={nodes} nodeId={nodeId} onChange={onChange} />;
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
        <div className="chips">
          {(property.items.enum ?? []).map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                className={`chip ${active ? 'chip-active' : ''}`}
                onClick={() =>
                  onChange(active ? selected.filter((v) => v !== option) : [...selected, option])
                }
              >
                {option}
              </button>
            );
          })}
        </div>
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
        <select
          value={String(value ?? property.default ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {property.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (property.type === 'number' || property.type === 'integer') {
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          type="number"
          min={property.minimum}
          max={property.maximum}
          value={value === undefined || value === null ? '' : Number(value)}
          onChange={(event) =>
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
      </label>
    );
  }

  if (ui?.widget === 'textarea') {
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <textarea
          rows={4}
          placeholder={ui.placeholder}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
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
  nodeId,
  onChange,
}: {
  label: string;
  accept: BindingType;
  multiline?: boolean;
  placeholder?: string;
  value: unknown;
  nodes: AgentNode[];
  nodeId: string;
  onChange: (value: unknown) => void;
}) {
  const binding = readBinding(value);
  const choices = outputChoices(nodes, nodeId, accept);
  const known = choices.some((choice) => choice.ref === binding.ref);

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <select
        className="binding-source"
        value={binding.mode === 'ref' ? binding.ref : ''}
        onChange={(event) => {
          const ref = event.target.value;
          onChange(ref ? { mode: 'ref', ref, value: binding.value } : { mode: 'custom', ref: '', value: binding.value });
        }}
      >
        <option value="">自定义</option>
        {binding.mode === 'ref' && binding.ref && !known && (
          <option value={binding.ref}>{binding.ref}（类型不匹配或已删除）</option>
        )}
        {choices.map((choice) => (
          <option key={choice.ref} value={choice.ref}>
            {choice.label}
          </option>
        ))}
      </select>
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
  nodeId,
  onChange,
}: {
  label: string;
  value: unknown;
  nodes: AgentNode[];
  nodeId: string;
  onChange: (value: unknown) => void;
}) {
  if (typeof value === 'string') {
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
        <button type="button" className="btn btn-mini" onClick={() => onChange([])}>
          改用下拉选择
        </button>
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
          const choices = outputChoices(nodes, nodeId, type);
          const known = choices.some((choice) => choice.ref === row.ref);
          return (
            <div className="binding-row" key={index}>
              <div className="binding-row__head">
                <input
                  placeholder="输入名，如 query"
                  value={name}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
                <select
                  value={type}
                  onChange={(event) =>
                    update(index, { type: event.target.value, mode: 'custom', ref: '', value: '' })
                  }
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="object">object</option>
                </select>
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
              <select
                value={row.mode === 'ref' ? row.ref : ''}
                onChange={(event) => {
                  const ref = event.target.value;
                  update(index, ref ? { mode: 'ref', ref } : { mode: 'custom', ref: '' });
                }}
              >
                <option value="">自定义</option>
                {row.mode === 'ref' && row.ref && !known && (
                  <option value={row.ref}>{row.ref}（类型不匹配或已删除）</option>
                )}
                {choices.map((choice) => (
                  <option key={choice.ref} value={choice.ref}>
                    {choice.label}
                  </option>
                ))}
              </select>
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
      <button
        type="button"
        className="btn btn-mini"
        onClick={() => onChange([...rows, { name: '', type: 'string', mode: 'custom', value: '', ref: '' }])}
      >
        + 添加输入
      </button>
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
      <select value={current} onChange={(event) => onChange(event.target.value === 'true')}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (type === 'number') {
    return (
      <input
        type="number"
        placeholder={placeholder}
        value={value === undefined || value === null || value === '' ? '' : Number(value)}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
      />
    );
  }
  if (multiline || type === 'object') {
    const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    return (
      <textarea
        rows={4}
        placeholder={placeholder}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <input
      placeholder={placeholder}
      value={value == null ? '' : String(value)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function isPortType(value: unknown): value is PortType {
  return value === 'string' || value === 'number' || value === 'boolean' || value === 'object';
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
          <input
            placeholder="变量名，如 topic"
            value={variable.name ?? ''}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <select
            value={variable.type ?? 'string'}
            onChange={(event) => update(index, { type: event.target.value as VariableDecl['type'] })}
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </select>
          <label className="inline">
            <input
              type="checkbox"
              checked={variable.required !== false}
              onChange={(event) => update(index, { required: event.target.checked })}
            />
            必填
          </label>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => onChange(variables.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-mini"
        onClick={() => onChange([...variables, { name: '', type: 'string', required: true }])}
      >
        + 添加变量
      </button>
      <p className="hint">
        在提示词里用 <code>{'{{input.变量名}}'}</code> 引用；运行时会按类型校验。
        可用工具：{toolNames().join('、')}
      </p>
    </div>
  );
}
