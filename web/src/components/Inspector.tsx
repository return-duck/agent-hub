import { useStudio } from '../store/studioStore.js';
import { nodeSpec, toolNames } from '../manifest.js';
import type { JsonSchemaProperty, VariableDecl } from '../generated/manifest.js';

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
  const uiSchema = (spec?.uiSchema ?? {}) as Record<string, { widget?: string; placeholder?: string }>;
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
          onChange={(value) => updateNodeConfig(node.id, { [key]: value })}
        />
      ))}

      <button className="btn btn-danger btn-block" onClick={() => removeNode(node.id)}>
        删除该节点
      </button>
    </div>
  );
}

interface FieldProps {
  name: string;
  property: JsonSchemaProperty;
  ui?: { widget?: string; placeholder?: string };
  value: unknown;
  onChange: (value: unknown) => void;
}

function Field({ name, property, ui, value, onChange }: FieldProps) {
  if (ui?.widget === 'variableList') {
    return (
      <div className="field">
        <span className="field__label">{name}</span>
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
        <span className="field__label">{name}</span>
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
        <span className="field__label">{name}</span>
        <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
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
        <span className="field__label">{name}</span>
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
        <span className="field__label">{name}</span>
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
      <span className="field__label">{name}</span>
      <input
        placeholder={ui?.placeholder}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
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
