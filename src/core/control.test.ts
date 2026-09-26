import { describe, expect, it } from 'vitest';
import { adjustTraverse } from './adjustment';
import {
  adjustTraverseControlled,
  CONTROL_COORD_LIMIT,
  describeInfeasible,
  MAX_CONTROL_STATIONS,
  validateControlConfig,
} from './control';
import type {
  ControlDraft,
  ControlStation,
  ControlledAdjustmentResult,
  RawEdge,
} from './types';

// ---------------------------------------------------------------------------
// 独立参考实现：按规格逐段重算，不 import 任何生产分配/平差代码，
// 用于交叉核对 adjustTraverseControlled 的每一处区段与每条边修正。
// ---------------------------------------------------------------------------

/** 下整商（与生产实现不同的等价写法） */
function refFloorDiv(a: bigint, b: bigint): bigint {
  let q = a / b;
  if (a % b !== 0n && a < 0n !== b < 0n) q -= 1n;
  return q;
}

/** 按权重最大余数分配：余数降序，同余数按 id 的 UTF-8 字节序 */
function refAllocate(ids: string[], weights: bigint[], total: bigint): bigint[] {
  const W = weights.reduce((s, w) => s + w, 0n);
  const bases = weights.map((w) => refFloorDiv(total * w, W));
  const rems = weights.map((w, i) => total * w - bases[i] * W);
  let rest = total - bases.reduce((s, b) => s + b, 0n);
  const encoder = new TextEncoder();
  const order = ids.map((_, i) => i);
  order.sort((i, j) => {
    if (rems[i] !== rems[j]) return rems[i] > rems[j] ? -1 : 1;
    const a = encoder.encode(ids[i]);
    const b = encoder.encode(ids[j]);
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n; k++) {
      if (a[k] !== b[k]) return a[k] - b[k];
    }
    return a.length - b.length;
  });
  const amounts = [...bases];
  for (const i of order) {
    if (rest <= 0n) break;
    amounts[i] += 1n;
    rest -= 1n;
  }
  return amounts;
}

interface RefSegment {
  fromVertex: number;
  toVertex: number;
  rawX: bigint;
  rawY: bigint;
  needX: bigint;
  needY: bigint;
}

type RefOutcome =
  | {
      ok: true;
      corr: Map<string, { x: bigint; y: bigint }>;
      segments: RefSegment[];
    }
  | { ok: false; segmentIndex: number };

/** 独立逐段计算：边界 v0 → 控制站（升序）→ vn，段内只分未锁边 */
function refControlled(
  edges: RawEdge[],
  stations: ControlStation[],
  lockedIds: string[],
): RefOutcome {
  const n = edges.length;
  const lockSet = new Set(lockedIds);
  const ordered = [...stations].sort((a, b) => a.vertexIndex - b.vertexIndex);
  const bounds = [
    { v: 0, x: 0n, y: 0n },
    ...ordered.map((s) => ({ v: s.vertexIndex, x: BigInt(s.x), y: BigInt(s.y) })),
    { v: n, x: 0n, y: 0n },
  ];
  const px = [0n];
  const py = [0n];
  for (const e of edges) {
    px.push(px[px.length - 1] + BigInt(e.dx));
    py.push(py[py.length - 1] + BigInt(e.dy));
  }
  const corr = new Map<string, { x: bigint; y: bigint }>();
  for (const e of edges) corr.set(e.id, { x: 0n, y: 0n });
  const segments: RefSegment[] = [];

  for (let s = 0; s + 1 < bounds.length; s++) {
    const from = bounds[s];
    const to = bounds[s + 1];
    const rawX = px[to.v] - px[from.v];
    const rawY = py[to.v] - py[from.v];
    const needX = to.x - from.x - rawX;
    const needY = to.y - from.y - rawY;
    const freeIdx: number[] = [];
    for (let i = from.v; i < to.v; i++) {
      if (!lockSet.has(edges[i].id)) freeIdx.push(i);
    }
    if (freeIdx.length === 0) {
      if (needX !== 0n || needY !== 0n) return { ok: false, segmentIndex: s };
    } else {
      const ids = freeIdx.map((i) => edges[i].id);
      const ws = freeIdx.map((i) => BigInt(edges[i].weight));
      const ax = refAllocate(ids, ws, needX);
      const ay = refAllocate(ids, ws, needY);
      freeIdx.forEach((edgeIdx, j) =>
        corr.set(edges[edgeIdx].id, { x: ax[j], y: ay[j] }),
      );
    }
    segments.push({ fromVertex: from.v, toVertex: to.v, rawX, rawY, needX, needY });
  }
  return { ok: true, corr, segments };
}

/** 平差结果在顶点 v_k 处的累计坐标（BigInt 精确） */
function cumulativeAt(result: ControlledAdjustmentResult, vertex: number) {
  let x = 0n;
  let y = 0n;
  for (let i = 0; i < vertex; i++) {
    x += BigInt(result.edges[i].dx) + result.edges[i].corrX;
    y += BigInt(result.edges[i].dy) + result.edges[i].corrY;
  }
  return { x, y };
}

/** 用独立参考实现全面核对一次控制站平差 */
function expectMatchesReference(
  edges: RawEdge[],
  stations: ControlStation[],
  lockedIds: string[],
) {
  const ref = refControlled(edges, stations, lockedIds);
  const outcome = adjustTraverseControlled(edges, {
    stations,
    lockedEdgeIds: lockedIds,
  });
  if (!ref.ok) {
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.infeasible.segmentIndex).toBe(ref.segmentIndex);
    }
    return;
  }
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  const r = outcome.result;

  // 每条边修正与独立参考一致；锁边两轴恒为 0
  const lockSet = new Set(lockedIds);
  for (const e of r.edges) {
    const want = ref.corr.get(e.id);
    expect(want, `参考实现缺少边 ${e.id}`).toBeTruthy();
    expect(e.corrX).toBe(want!.x);
    expect(e.corrY).toBe(want!.y);
    if (lockSet.has(e.id)) {
      expect(e.corrX).toBe(0n);
      expect(e.corrY).toBe(0n);
    }
  }

  // 区段明细与独立参考一致
  expect(r.segments).toHaveLength(ref.segments.length);
  r.segments.forEach((seg, i) => {
    expect(seg.fromVertex).toBe(ref.segments[i].fromVertex);
    expect(seg.toVertex).toBe(ref.segments[i].toVertex);
    expect(seg.rawX).toBe(ref.segments[i].rawX);
    expect(seg.rawY).toBe(ref.segments[i].rawY);
    expect(seg.needX).toBe(ref.segments[i].needX);
    expect(seg.needY).toBe(ref.segments[i].needY);
    // 段内修正总量恰好等于所需修正
    let sx = 0n;
    let sy = 0n;
    for (let k = seg.fromVertex; k < seg.toVertex; k++) {
      sx += r.edges[k].corrX;
      sy += r.edges[k].corrY;
    }
    expect(sx).toBe(seg.needX);
    expect(sy).toBe(seg.needY);
  });

  // 各控制站原值保留：调整后折线在该顶点严格等于指定坐标
  for (const s of stations) {
    const p = cumulativeAt(r, s.vertexIndex);
    expect(p.x).toBe(BigInt(s.x));
    expect(p.y).toBe(BigInt(s.y));
  }
  // 最终闭合：终点严格回到原点
  const end = cumulativeAt(r, edges.length);
  expect(end.x).toBe(0n);
  expect(end.y).toBe(0n);
}

const edgesA: RawEdge[] = [
  { id: 'E1', dx: 100, dy: 0, weight: 1 },
  { id: 'E2', dx: 100, dy: 0, weight: 1 },
  { id: 'E3', dx: 100, dy: 0, weight: 1 },
  { id: 'E4', dx: 0, dy: 100, weight: 1 },
  { id: 'E5', dx: -300, dy: 0, weight: 1 },
  { id: 'E6', dx: 0, dy: -100, weight: 1 },
];

describe('adjustTraverseControlled — 逐段独立核对', () => {
  it('两个控制站：各站位原值保留、负修正、同余数按 UTF-8 字节序、最终闭合', () => {
    const stations: ControlStation[] = [
      { vertexIndex: 2, x: 200, y: 5 },
      { vertexIndex: 4, x: 310, y: 100 },
    ];
    expectMatchesReference(edgesA, stations, []);

    const outcome = adjustTraverseControlled(edgesA, {
      stations,
      lockedEdgeIds: [],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.result;
    const byId = Object.fromEntries(r.edges.map((e) => [e.id, e]));
    // 段 1 的 y 尚需 +5：E1/E2 等权同余数，UTF-8 字节序 E1 优先多得 1
    expect(byId.E1.corrY).toBe(3n);
    expect(byId.E2.corrY).toBe(2n);
    // 段 2 的 y 尚需 −5：负修正方向，E3 拿 +1 后为 −2，E4 为 −3
    expect(byId.E3.corrY).toBe(-2n);
    expect(byId.E4.corrY).toBe(-3n);
    // 段 3 的 x 尚需 −10：整除无余数
    expect(byId.E5.corrX).toBe(-5n);
    expect(byId.E6.corrX).toBe(-5n);
    // 控制站原值保留
    expect(cumulativeAt(r, 2)).toEqual({ x: 200n, y: 5n });
    expect(cumulativeAt(r, 4)).toEqual({ x: 310n, y: 100n });
    expect(cumulativeAt(r, 6)).toEqual({ x: 0n, y: 0n });
  });

  it('锁边修正恒为零，段内修正全部落在未锁边上', () => {
    const stations: ControlStation[] = [{ vertexIndex: 2, x: 200, y: 5 }];
    expectMatchesReference(edgesA, stations, ['E1']);
    const outcome = adjustTraverseControlled(edgesA, {
      stations,
      lockedEdgeIds: ['E1'],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byId = Object.fromEntries(outcome.result.edges.map((e) => [e.id, e]));
    expect(byId.E1.corrX).toBe(0n);
    expect(byId.E1.corrY).toBe(0n);
    // 段 1 只剩 E2 可调，+5 全给它
    expect(byId.E2.corrY).toBe(5n);
  });

  it('全锁区段原始位移恰好满足端点：可行且整段零修正', () => {
    // 段 2（E3,E4）全锁，K2 定在 (300,105) 使段 2 所需修正为 (0,0)
    const stations: ControlStation[] = [
      { vertexIndex: 2, x: 200, y: 5 },
      { vertexIndex: 4, x: 300, y: 105 },
    ];
    const locked = ['E1', 'E3', 'E4'];
    expectMatchesReference(edgesA, stations, locked);
    const outcome = adjustTraverseControlled(edgesA, {
      stations,
      lockedEdgeIds: locked,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byId = Object.fromEntries(outcome.result.edges.map((e) => [e.id, e]));
    expect(byId.E3.corrX).toBe(0n);
    expect(byId.E4.corrY).toBe(0n);
    // 段 1 只有 E2 可调；段 3 的 y 尚需 −5 由 E5/E6 分担
    expect(byId.E2.corrY).toBe(5n);
    expect(byId.E5.corrY + byId.E6.corrY).toBe(-5n);
    expect(cumulativeAt(outcome.result, 6)).toEqual({ x: 0n, y: 0n });
  });

  it('全锁区段位移不满足端点：返回定位该区段的不可行结论，不产出部分结果', () => {
    // 锁死 E1,E2（段 1 无可调边），K1 的 y=5 无法满足
    const outcome = adjustTraverseControlled(edgesA, {
      stations: [{ vertexIndex: 2, x: 200, y: 5 }],
      lockedEdgeIds: ['E1', 'E2'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.infeasible.segmentIndex).toBe(0);
    expect(outcome.infeasible.fromVertex).toBe(0);
    expect(outcome.infeasible.toVertex).toBe(2);
    expect(outcome.infeasible.needY).toBe(5n);
    expect(outcome.infeasible.adjustableEdgeIds).toEqual([]);
    expect(outcome.infeasible.lockedEdgeIds).toEqual(['E1', 'E2']);
    // 不可行结论可定位到具体区段（供页面提示，不发布任何新图）
    const msg = describeInfeasible(outcome.infeasible, edgesA.length);
    expect(msg).toContain('区段 1');
    expect(msg).toContain('不可行');
  });

  it('不可行发生在后段时同样整体拒绝（前段可行也不发布）', () => {
    // 段 1 可行；段 2（E3,E4）全锁但 K2 坐标不满足
    const outcome = adjustTraverseControlled(edgesA, {
      stations: [
        { vertexIndex: 2, x: 200, y: 5 },
        { vertexIndex: 4, x: 999, y: 999 },
      ],
      lockedEdgeIds: ['E3', 'E4'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.infeasible.segmentIndex).toBe(1);
    expect(outcome.infeasible.fromVertex).toBe(2);
    expect(outcome.infeasible.toVertex).toBe(4);
  });

  it('大权重（2^53−1）段内分配保持 BigInt 精确', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const edges: RawEdge[] = [
      { id: 'G1', dx: 3, dy: 1, weight: 1 },
      { id: 'G2', dx: 3, dy: 1, weight: 1 },
      { id: 'G3', dx: 0, dy: 0, weight: big },
      { id: 'G4', dx: -6, dy: -2, weight: 1 },
    ];
    const stations: ControlStation[] = [{ vertexIndex: 2, x: 10, y: 10 }];
    expectMatchesReference(edges, stations, []);
    const outcome = adjustTraverseControlled(edges, {
      stations,
      lockedEdgeIds: [],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.result;
    expect(r.totalWeight).toBe(BigInt(big) + 3n);
    const byId = Object.fromEntries(r.edges.map((e) => [e.id, e]));
    // 段 2 尚需 (−4,−8)：大权重边 G3 的配额下整商为 (−4,−8)，余数 4/8；
    // 余下 1 个单位归余数更大的 G4（r = 2^53−4），故 G4 为 0、G3 承担全部
    expect(byId.G3.corrX).toBe(-4n);
    expect(byId.G3.corrY).toBe(-8n);
    expect(byId.G4.corrX).toBe(0n);
    expect(byId.G4.corrY).toBe(0n);
    expect(cumulativeAt(r, 2)).toEqual({ x: 10n, y: 10n });
    expect(cumulativeAt(r, 4)).toEqual({ x: 0n, y: 0n });
  });

  it('空配置（无控制站、无锁边）与整网平差逐边一致', () => {
    const edges: RawEdge[] = [
      { id: 'a', dx: 10, dy: 5, weight: 2 },
      { id: 'b', dx: -3, dy: 5, weight: 1 },
      { id: 'c', dx: -4, dy: -8, weight: 1 },
      { id: 'd', dx: 0, dy: 0, weight: 2 },
    ];
    const free = adjustTraverse(edges);
    const outcome = adjustTraverseControlled(edges, {
      stations: [],
      lockedEdgeIds: [],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.segments).toHaveLength(1);
    outcome.result.edges.forEach((e, i) => {
      expect(e.corrX).toBe(free.edges[i].corrX);
      expect(e.corrY).toBe(free.edges[i].corrY);
    });
  });

  it('确定性随机扫描：独立逐段参考逐边核对（含随机锁边与不可行）', () => {
    let seed = 20260926;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let infeasibleCount = 0;
    for (let t = 0; t < 200; t++) {
      const n = 3 + Math.floor(rand() * 8);
      const edges: RawEdge[] = Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        dx: Math.floor(rand() * 2001) - 1000,
        dy: Math.floor(rand() * 2001) - 1000,
        weight: 1 + Math.floor(rand() * 50),
      }));
      const maxStations = Math.min(MAX_CONTROL_STATIONS, n - 1);
      const stationCount = Math.floor(rand() * (maxStations + 1));
      const vertices = new Set<number>();
      while (vertices.size < stationCount) {
        vertices.add(1 + Math.floor(rand() * (n - 1)));
      }
      const stations: ControlStation[] = [...vertices].map((v) => ({
        vertexIndex: v,
        x: Math.floor(rand() * 4001) - 2000,
        y: Math.floor(rand() * 4001) - 2000,
      }));
      const locked = edges.filter(() => rand() < 0.25).map((e) => e.id);
      const ref = refControlled(edges, stations, locked);
      if (!ref.ok) infeasibleCount += 1;
      expectMatchesReference(edges, stations, locked);
    }
    // 两种分支都被充分覆盖
    expect(infeasibleCount).toBeGreaterThan(0);
  });
});

describe('validateControlConfig — 非法编辑整体拒绝', () => {
  const draft = (
    stations: ControlDraft['stations'],
    lockedEdgeIds: string[] = [],
  ): ControlDraft => ({ stations, lockedEdgeIds });

  it('重复站位（同一顶点指定两次）被拒绝', () => {
    const r = validateControlConfig(
      draft([
        { vertexIndex: 2, x: '200', y: '5' },
        { vertexIndex: 2, x: '0', y: '0' },
      ]),
      edgesA,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('重复');
  });

  it('站位数超过 3 个被拒绝', () => {
    const r = validateControlConfig(
      draft([
        { vertexIndex: 1, x: '0', y: '0' },
        { vertexIndex: 2, x: '0', y: '0' },
        { vertexIndex: 3, x: '0', y: '0' },
        { vertexIndex: 4, x: '0', y: '0' },
      ]),
      edgesA,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('最多');
  });

  it('站位不能落在起点 v0 或最后终点 vn', () => {
    for (const v of [0, edgesA.length]) {
      const r = validateControlConfig(
        draft([{ vertexIndex: v, x: '0', y: '0' }]),
        edgesA,
      );
      expect(r.ok).toBe(false);
    }
  });

  it('非整数坐标（小数、科学计数法、空串、超界）被拒绝', () => {
    for (const bad of ['1.5', '1e3', '', 'abc', `${CONTROL_COORD_LIMIT + 1}`]) {
      const r = validateControlConfig(
        draft([{ vertexIndex: 2, x: bad, y: '0' }]),
        edgesA,
      );
      expect(r.ok).toBe(false);
    }
    // 边界值本身合法
    const ok = validateControlConfig(
      draft([
        {
          vertexIndex: 2,
          x: String(CONTROL_COORD_LIMIT),
          y: String(-CONTROL_COORD_LIMIT),
        },
      ]),
      edgesA,
    );
    expect(ok.ok).toBe(true);
  });

  it('锁定未知边 id 被拒绝；重复锁定自动去重', () => {
    const bad = validateControlConfig(draft([], ['E1', 'ZZ']), edgesA);
    expect(bad.ok).toBe(false);
    const good = validateControlConfig(draft([], ['E1', 'E1', 'E2']), edgesA);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.config.lockedEdgeIds).toEqual(['E1', 'E2']);
  });

  it('完全空行忽略；合法配置按顶点升序规范化', () => {
    const r = validateControlConfig(
      draft(
        [
          { vertexIndex: null, x: '', y: '' }, // 空行忽略
          { vertexIndex: 4, x: '310', y: '100' },
          { vertexIndex: 2, x: '200', y: '5' },
        ],
        [],
      ),
      edgesA,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.stations.map((s) => s.vertexIndex)).toEqual([2, 4]);
    }
  });
});
