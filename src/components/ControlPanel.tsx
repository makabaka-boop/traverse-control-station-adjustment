import {
  MAX_CONTROL_STATIONS,
  vertexLabel,
} from '../core/control';
import {
  isControlledResult,
  type AnyAdjustmentResult,
  type ControlDraft,
  type RawEdge,
} from '../core/types';

interface ControlPanelProps {
  edges: RawEdge[];
  draft: ControlDraft;
  onDraftChange: (draft: ControlDraft) => void;
  onApply: () => void;
  /** 编辑态未通过校验时禁用采纳（非法编辑不得覆盖已采纳结果） */
  applyDisabled: boolean;
  /** 编辑态即时校验错误 */
  liveError: string | null;
  /** 草稿与已采纳配置不一致（含非法编辑）：已采纳结果已过期 */
  stale: boolean;
  /** 采纳时产生的错误（如某区段不可行） */
  panelError: string | null;
  /** 当前展示的结果（控制站结果时渲染区段明细） */
  result: AnyAdjustmentResult | null;
}

/**
 * 控制站平差编辑面板：指定至多 3 个互异中间控制站（有序边终点的顶点序号 +
 * 相对起点的整数毫米坐标），并按边 id 锁定封存观测边。
 * 所有编辑只修改草稿；点击「采纳控制配置」才重新平差，
 * 非法编辑不会覆盖已采纳结果，只把当前成果标记为过期。
 */
export function ControlPanel({
  edges,
  draft,
  onDraftChange,
  onApply,
  applyDisabled,
  liveError,
  stale,
  panelError,
  result,
}: ControlPanelProps) {
  const setStation = (index: number, patch: Partial<ControlDraft['stations'][number]>) => {
    onDraftChange({
      ...draft,
      stations: draft.stations.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  };

  const removeStation = (index: number) => {
    onDraftChange({ ...draft, stations: draft.stations.filter((_, i) => i !== index) });
  };

  const addStation = () => {
    onDraftChange({
      ...draft,
      stations: [...draft.stations, { vertexIndex: null, x: '', y: '' }],
    });
  };

  const toggleLock = (id: string, locked: boolean) => {
    onDraftChange({
      ...draft,
      lockedEdgeIds: locked
        ? [...draft.lockedEdgeIds, id]
        : draft.lockedEdgeIds.filter((x) => x !== id),
    });
  };

  const controlled = result !== null && isControlledResult(result) ? result : null;

  return (
    <div className="control-panel" data-testid="control-panel">
      <h2>控制站与锁边（控制站平差）</h2>
      <p className="hint">
        控制站为独立仪器定准的中间站位，须落在某条有序边的终点（v1…v
        {edges.length - 1}），坐标为相对起点 v0 的整数毫米；起点 v0 与最后终点 v
        {edges.length} 固定为原点。控制站把整圈切成连续区段，每段只在
        <strong>未锁边</strong>之间按原权重分配修正；锁定（封存）边两轴修正恒为 0。
        编辑不会自动生效，点击「采纳控制配置」后才重算。
      </p>

      {stale && (
        <div className="banner warn" role="status" data-testid="control-stale">
          <strong>已采纳结果已过期：</strong>
          控制配置被修改但尚未采纳，当前图形、表格与导出仍是上次采纳的结果，
          不会被自动覆盖；点击「采纳控制配置」后生效。
        </div>
      )}
      {panelError && (
        <div className="banner error" role="alert" data-testid="control-error">
          <strong>未发布新成果：</strong>
          {panelError}
        </div>
      )}
      {liveError && (
        <div className="banner error" role="alert" data-testid="control-validation">
          <strong>当前编辑未通过校验：</strong>
          {liveError}（已采纳结果保持不变）
        </div>
      )}

      <div className="station-rows">
        {draft.stations.map((s, i) => (
          <div className="station-row" data-testid={`station-row-${i}`} key={i}>
            <span className="station-tag">K{i + 1}</span>
            <select
              aria-label={`控制站 ${i + 1} 站位`}
              value={s.vertexIndex === null ? '' : String(s.vertexIndex)}
              onChange={(e) =>
                setStation(i, {
                  vertexIndex: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            >
              <option value="">（选择站位：某条边的终点）</option>
              {edges.slice(0, -1).map((edge, k) => (
                <option key={edge.id} value={k + 1}>
                  第 {k + 1} 条边 {edge.id} 的终点（v{k + 1}）
                </option>
              ))}
            </select>
            <input
              className="coord-input"
              aria-label={`控制站 ${i + 1} x 坐标`}
              placeholder="x (mm)"
              value={s.x}
              onChange={(e) => setStation(i, { x: e.target.value })}
            />
            <input
              className="coord-input"
              aria-label={`控制站 ${i + 1} y 坐标`}
              placeholder="y (mm)"
              value={s.y}
              onChange={(e) => setStation(i, { y: e.target.value })}
            />
            <button
              type="button"
              aria-label={`删除控制站 ${i + 1}`}
              onClick={() => removeStation(i)}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <div className="button-row">
        <button
          type="button"
          onClick={addStation}
          disabled={draft.stations.length >= MAX_CONTROL_STATIONS}
        >
          添加控制站（{draft.stations.length}/{MAX_CONTROL_STATIONS}）
        </button>
      </div>

      <h3 className="lock-title">锁定边（封存观测，修正恒为 0）</h3>
      <div className="lock-list">
        {edges.map((e) => (
          <label key={e.id} className="lock-item">
            <input
              type="checkbox"
              aria-label={`锁定边 ${e.id}`}
              checked={draft.lockedEdgeIds.includes(e.id)}
              onChange={(ev) => toggleLock(e.id, ev.target.checked)}
            />
            <span className="mono">{e.id}</span>
          </label>
        ))}
      </div>

      <div className="button-row">
        <button
          type="button"
          className="primary"
          data-testid="apply-control"
          onClick={onApply}
          disabled={applyDisabled}
        >
          采纳控制配置
        </button>
      </div>

      {controlled && (
        <div className="segments" data-testid="segments">
          <h3 className="lock-title">区段平差明细</h3>
          <p className="hint" data-testid="control-summary">
            控制站：
            {controlled.controlStations.length === 0
              ? '无'
              : controlled.controlStations
                  .map((s, i) => `K${i + 1}=v${s.vertexIndex} (${s.x}, ${s.y})`)
                  .join('；')}
            ｜锁定边：
            {controlled.lockedEdgeIds.length === 0
              ? '无'
              : controlled.lockedEdgeIds.join('、')}
          </p>
          {controlled.segments.map((seg) => (
            <div className="segment" data-testid={`segment-${seg.index}`} key={seg.index}>
              <strong>区段 {seg.index + 1}</strong>：
              {vertexLabel(seg.fromVertex, edges.length)} →{' '}
              {vertexLabel(seg.toVertex, edges.length)}，端点 (
              {seg.fromX.toString()}, {seg.fromY.toString()}) → ({seg.toX.toString()},{' '}
              {seg.toY.toString()})｜原始位移 ({seg.rawX.toString()},{' '}
              {seg.rawY.toString()})｜所需修正 ({seg.needX.toString()},{' '}
              {seg.needY.toString()})｜可调边{' '}
              {seg.adjustableEdgeIds.length === 0
                ? '无'
                : seg.adjustableEdgeIds.join('、')}
              （权重和 {seg.totalWeight.toString()}）｜锁定{' '}
              {seg.lockedEdgeIds.length === 0 ? '无' : seg.lockedEdgeIds.join('、')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
