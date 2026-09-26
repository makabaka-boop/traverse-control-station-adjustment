import type { ControlDraft } from '../core/controlOptions';
import type { RawEdge } from '../core/types';

interface ControlEditorProps {
  draft: ControlDraft;
  edges: RawEdge[];
  /** 草稿解析错误（非法控制站编辑） */
  validationError: string | null;
  /** 当前草稿相对于已采纳结果是否已过期 */
  stale: boolean;
  /** 不可行（全锁段等）导致未发布时的定位信息 */
  infeasible: { segmentIndex: number; message: string } | null;
  onDraftChange: (next: ControlDraft) => void;
  onApply: () => void;
  onRevert: () => void;
  /** 当前是否处于控制站平差模式（已有采纳结果） */
  adopted: boolean;
}

export function ControlEditor({
  draft,
  edges,
  validationError,
  stale,
  infeasible,
  onDraftChange,
  onApply,
  onRevert,
  adopted,
}: ControlEditorProps) {
  const updateStation = (
    i: number,
    patch: Partial<ControlDraft['stations'][number]>,
  ) => {
    onDraftChange({
      ...draft,
      stations: draft.stations.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    });
  };

  const addStation = () => {
    if (draft.stations.length >= 3) return;
    onDraftChange({
      ...draft,
      stations: [
        ...draft.stations,
        // 默认预选第一个中间终点（第 1 条边终点）
        { endEdge: '1', x: '0', y: '0' },
      ],
    });
  };

  const removeStation = (i: number) => {
    onDraftChange({
      ...draft,
      stations: draft.stations.filter((_, j) => j !== i),
    });
  };

  return (
    <section className="panel control-panel" data-testid="control-editor">
      <h2>控制站平差（可选）</h2>
      <p className="hint">
        在有序边的<strong>终点</strong>中指定最多 3 个互异中间控制站，给定相对起点的整数毫米坐标；
        可按边 id 锁定封存观测边（逗号分隔）。起点与最后终点恒为原点。
        每段只让<strong>未锁边</strong>按原权重分配修正，锁边两轴修正恒为 0。
      </p>

      <div className="control-stations">
        {draft.stations.map((row, i) => (
          <div className="control-row" key={i} data-testid={`station-row-${i}`}>
            <span className="control-tag">K{i + 1}</span>
            <label className="control-field">
              站位
              <select
                aria-label={`控制站 ${i + 1} 站位（边序号）`}
                value={row.endEdge}
                onChange={(e) => updateStation(i, { endEdge: e.target.value })}
              >
                {edges.slice(0, -1).map((e, idx) => (
                  <option key={e.id} value={String(idx + 1)}>
                    第 {idx + 1} 边终点（{e.id} 后）
                  </option>
                ))}
              </select>
            </label>
            <label className="control-field">
              x
              <input
                aria-label={`控制站 ${i + 1} x 坐标`}
                className="coord-input"
                inputMode="numeric"
                value={row.x}
                onChange={(e) => updateStation(i, { x: e.target.value })}
              />
            </label>
            <label className="control-field">
              y
              <input
                aria-label={`控制站 ${i + 1} y 坐标`}
                className="coord-input"
                inputMode="numeric"
                value={row.y}
                onChange={(e) => updateStation(i, { y: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="control-remove"
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
          disabled={draft.stations.length >= 3}
          data-testid="add-station"
        >
          添加控制站
        </button>
      </div>

      <label className="lock-field">
        锁定边 id（逗号分隔，封存观测边不参与平差）
        <input
          aria-label="锁定边 id 列表"
          className="lock-input"
          value={draft.lockedEdgeIds}
          placeholder="例如：E2, E4"
          onChange={(e) => onDraftChange({ ...draft, lockedEdgeIds: e.target.value })}
        />
      </label>

      <div className="button-row">
        <button
          type="button"
          className="primary"
          onClick={onApply}
          data-testid="apply-control"
        >
          采纳控制并平差
        </button>
        <button
          type="button"
          onClick={onRevert}
          disabled={!adopted && draft.stations.length === 0 && !draft.lockedEdgeIds.trim()}
          data-testid="revert-control"
        >
          恢复普通平差
        </button>
      </div>

      {validationError && (
        <div className="banner error" role="alert" data-testid="control-error">
          <strong>控制站编辑非法，已保留上次采纳结果：</strong>
          {validationError}
        </div>
      )}
      {infeasible && !validationError && (
        <div className="banner error" role="alert" data-testid="control-infeasible">
          <strong>
            第 {infeasible.segmentIndex + 1} 段不可行，未发布任何部分新图：
          </strong>
          {infeasible.message}
        </div>
      )}
      {stale && !validationError && !infeasible && (
        <div className="banner stale" role="status" data-testid="control-stale">
          控制编辑尚未采纳或与已采纳结果不一致：当前画面与导出仍为上次采纳结果，编辑内容已标记
          <strong>过期</strong>。
        </div>
      )}
    </section>
  );
}
