import { allocateLargestRemainder } from './allocation';
import type {
  ControlConfig,
  ControlDraft,
  ControlStation,
  ControlledAdjustmentOutcome,
  ControlledAdjustmentResult,
  EdgeAdjustment,
  InfeasibleSegment,
  RawEdge,
  SegmentAdjustment,
} from './types';

/** 控制站最多可指定的中间站位数 */
export const MAX_CONTROL_STATIONS = 3;
/**
 * 控制站坐标（相对起点的整数毫米）允许范围。
 * 200 条边、单边 |分量| ≤ 10⁶ 时原始顶点最大约 2×10⁸；
 * 界内坐标保证平差后顶点仍是安全整数，且修正量不超过单段 |need|。
 */
export const CONTROL_COORD_LIMIT = 200_000_000;

export function emptyControlDraft(): ControlDraft {
  return { stations: [], lockedEdgeIds: [] };
}

/** 解析整数毫米文本：只允许十进制整数字面量（可带负号），拒绝小数/科学计数法 */
function parseIntegerText(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const v = Number(t);
  return Number.isSafeInteger(v) ? v : null;
}

/** 控制站行是否已被编辑（选了站位或填了任一坐标）；完全空行忽略 */
function isStationRowActive(s: ControlDraft['stations'][number]): boolean {
  return s.vertexIndex !== null || s.x.trim() !== '' || s.y.trim() !== '';
}

export type ControlConfigOutcome =
  | { ok: true; config: ControlConfig }
  | { ok: false; error: string };

/**
 * 校验编辑态控制配置并规范化为可采纳配置：
 * - 站位必须落在中间顶点 v1…v(n−1)（n 为边数，v0 起点与 vn 终点固定为原点）；
 * - 站位互异且至多 3 个；坐标为 |值| ≤ 2×10⁸ 的整数毫米；
 * - 锁边 id 必须存在于当前边集（重复选择自动去重）。
 * 任一非法即整体拒绝，由调用方保留已采纳结果并标记过期。
 */
export function validateControlConfig(
  draft: ControlDraft,
  edges: RawEdge[],
): ControlConfigOutcome {
  const n = edges.length;
  const active = draft.stations.filter(isStationRowActive);
  if (active.length > MAX_CONTROL_STATIONS) {
    return {
      ok: false,
      error: `控制站最多 ${MAX_CONTROL_STATIONS} 个，当前已填 ${active.length} 个`,
    };
  }

  const stations: ControlStation[] = [];
  const seenVertices = new Set<number>();
  for (let i = 0; i < active.length; i++) {
    const row = active[i];
    const label = `控制站 ${i + 1}`;
    if (row.vertexIndex === null) {
      return { ok: false, error: `${label}：必须选择站位（某条边的终点）` };
    }
    const k = row.vertexIndex;
    if (!Number.isInteger(k) || k < 1 || k > n - 1) {
      return {
        ok: false,
        error: `${label}：站位必须是中间顶点 v1…v${n - 1}（起点与最后终点固定为原点）`,
      };
    }
    if (seenVertices.has(k)) {
      return { ok: false, error: `站位重复：v${k} 被指定了多次，控制站必须互异` };
    }
    const x = parseIntegerText(row.x);
    const y = parseIntegerText(row.y);
    if (x === null || y === null) {
      return { ok: false, error: `${label}：x/y 必须是整数毫米坐标` };
    }
    if (Math.abs(x) > CONTROL_COORD_LIMIT || Math.abs(y) > CONTROL_COORD_LIMIT) {
      return {
        ok: false,
        error: `${label}：坐标绝对值不能超过 ${CONTROL_COORD_LIMIT}（整数毫米）`,
      };
    }
    seenVertices.add(k);
    stations.push({ vertexIndex: k, x, y });
  }
  stations.sort((a, b) => a.vertexIndex - b.vertexIndex);

  const edgeIds = new Set(edges.map((e) => e.id));
  const lockedEdgeIds: string[] = [];
  const seenLocked = new Set<string>();
  for (const id of draft.lockedEdgeIds) {
    if (!edgeIds.has(id)) {
      return { ok: false, error: `锁定的边 id「${id}」不在当前边集中` };
    }
    if (seenLocked.has(id)) continue;
    seenLocked.add(id);
    lockedEdgeIds.push(id);
  }

  return { ok: true, config: { stations, lockedEdgeIds } };
}

/** 已采纳配置的稳定串，用于“编辑后未采纳 ⇒ 已采纳结果过期”的判定 */
export function configKey(config: ControlConfig): string {
  const stations = [...config.stations]
    .sort((a, b) => a.vertexIndex - b.vertexIndex)
    .map((s) => `${s.vertexIndex}@${s.x},${s.y}`)
    .join('|');
  const locked = [...config.lockedEdgeIds].sort().join('|');
  return `${stations}#${locked}`;
}

/** 顶点显示名：v0 起点、vn 终点、其余为第 k 条边的终点 */
export function vertexLabel(vertexIndex: number, edgeCount: number): string {
  if (vertexIndex === 0) return '起点 v0';
  if (vertexIndex === edgeCount) return `终点 v${edgeCount}`;
  return `v${vertexIndex}`;
}

/** 不可行结论的定位描述（用于错误条） */
export function describeInfeasible(
  infeasible: InfeasibleSegment,
  edgeCount: number,
): string {
  const from = vertexLabel(infeasible.fromVertex, edgeCount);
  const to = vertexLabel(infeasible.toVertex, edgeCount);
  return (
    `区段 ${infeasible.segmentIndex + 1}（${from} → ${to}）不可行：` +
    `段内边全部被锁定、没有可调边，而原始位移 ` +
    `(${infeasible.rawX.toString()}, ${infeasible.rawY.toString()}) ` +
    `不满足固定端点 (${infeasible.fromX.toString()}, ${infeasible.fromY.toString()}) → ` +
    `(${infeasible.toX.toString()}, ${infeasible.toY.toString()})，` +
    `尚缺 (${infeasible.needX.toString()}, ${infeasible.needY.toString()})。` +
    `未发布任何新成果图，请解除部分锁定或调整控制站后重试`
  );
}

/**
 * 控制站平差：控制站把整圈切成连续区段（v0 → 各控制站 → vn），
 * 每段独立计算到指定端点所需的 x/y 修正量，只在未锁边之间
 * 按原权重做 BigInt 最大余数分配（锁边两轴修正恒为 0）。
 *
 * 原子性：任一段没有可调边而原始位移不满足端点时，返回定位该段的
 * 不可行结论，不产出任何部分结果。
 */
export function adjustTraverseControlled(
  edges: RawEdge[],
  config: ControlConfig,
): ControlledAdjustmentOutcome {
  const n = edges.length;
  const locked = new Set(config.lockedEdgeIds);

  // 区段边界：起点 v0、各控制站（按顶点升序）、终点 vn，均固定为指定坐标。
  // validateControlConfig 已保证互异升序；此处再排序一次，使直接调用同样安全。
  const stations = [...config.stations].sort(
    (a, b) => a.vertexIndex - b.vertexIndex,
  );
  const boundaries: Array<{ vertex: number; x: bigint; y: bigint }> = [
    { vertex: 0, x: 0n, y: 0n },
    ...stations.map((s) => ({
      vertex: s.vertexIndex,
      x: BigInt(s.x),
      y: BigInt(s.y),
    })),
    { vertex: n, x: 0n, y: 0n },
  ];

  // 顶点原始坐标前缀和（BigInt，逐毫米精确）
  const prefixX: bigint[] = [0n];
  const prefixY: bigint[] = [0n];
  for (const e of edges) {
    prefixX.push(prefixX[prefixX.length - 1] + BigInt(e.dx));
    prefixY.push(prefixY[prefixY.length - 1] + BigInt(e.dy));
  }

  const corrX = new Array<bigint>(n).fill(0n);
  const corrY = new Array<bigint>(n).fill(0n);
  const segments: SegmentAdjustment[] = [];

  for (let s = 0; s < boundaries.length - 1; s++) {
    const from = boundaries[s];
    const to = boundaries[s + 1];
    const rawX = prefixX[to.vertex] - prefixX[from.vertex];
    const rawY = prefixY[to.vertex] - prefixY[from.vertex];
    const needX = to.x - from.x - rawX;
    const needY = to.y - from.y - rawY;

    const adjustableIdx: number[] = [];
    const lockedIds: string[] = [];
    for (let i = from.vertex; i < to.vertex; i++) {
      if (locked.has(edges[i].id)) lockedIds.push(edges[i].id);
      else adjustableIdx.push(i);
    }

    if (adjustableIdx.length === 0) {
      if (needX !== 0n || needY !== 0n) {
        return {
          ok: false,
          infeasible: {
            segmentIndex: s,
            fromVertex: from.vertex,
            toVertex: to.vertex,
            fromX: from.x,
            fromY: from.y,
            toX: to.x,
            toY: to.y,
            rawX,
            rawY,
            needX,
            needY,
            adjustableEdgeIds: [],
            lockedEdgeIds: lockedIds,
          },
        };
      }
      // 全锁但原始位移恰好满足端点：该段无需分配，修正恒为 0
      segments.push({
        index: s,
        fromVertex: from.vertex,
        toVertex: to.vertex,
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        rawX,
        rawY,
        needX,
        needY,
        totalWeight: 0n,
        adjustableEdgeIds: [],
        lockedEdgeIds: lockedIds,
      });
      continue;
    }

    const weighted = adjustableIdx.map((i) => ({
      id: edges[i].id,
      weight: BigInt(edges[i].weight),
    }));
    const allocX = allocateLargestRemainder(weighted, needX);
    const allocY = allocateLargestRemainder(weighted, needY);
    let segWeight = 0n;
    adjustableIdx.forEach((edgeIdx, j) => {
      corrX[edgeIdx] = allocX[j].amount;
      corrY[edgeIdx] = allocY[j].amount;
      segWeight += BigInt(edges[edgeIdx].weight);
    });

    segments.push({
      index: s,
      fromVertex: from.vertex,
      toVertex: to.vertex,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      rawX,
      rawY,
      needX,
      needY,
      totalWeight: segWeight,
      adjustableEdgeIds: adjustableIdx.map((i) => edges[i].id),
      lockedEdgeIds: lockedIds,
    });
  }

  const out: EdgeAdjustment[] = edges.map((e, i) => ({
    ...e,
    corrX: corrX[i],
    corrY: corrY[i],
  }));

  // 硬性不变量：修正后两轴整数和严格为零（终点固定为原点）
  const sumX = out.reduce((s, e) => s + BigInt(e.dx) + e.corrX, 0n);
  const sumY = out.reduce((s, e) => s + BigInt(e.dy) + e.corrY, 0n);
  if (sumX !== 0n || sumY !== 0n) {
    throw new Error('平差不变量失败：修正后分量和非零');
  }
  // 锁边两轴修正恒为零
  for (let i = 0; i < n; i++) {
    if (locked.has(edges[i].id) && (corrX[i] !== 0n || corrY[i] !== 0n)) {
      throw new Error('平差不变量失败：锁定边被分配了非零修正');
    }
  }

  const result: ControlledAdjustmentResult = {
    closureX: prefixX[n],
    closureY: prefixY[n],
    totalWeight: edges.reduce((s, e) => s + BigInt(e.weight), 0n),
    edges: out,
    controlStations: stations.map((s) => ({ ...s })),
    lockedEdgeIds: [...config.lockedEdgeIds],
    segments,
  };
  return { ok: true, result };
}
