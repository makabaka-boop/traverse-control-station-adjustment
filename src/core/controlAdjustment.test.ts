import { describe, expect, it } from 'vitest';
import {
  adjustWithControls,
  type ControlInfeasible,
} from './controlAdjustment';
import {
  controlOptionsKey,
  emptyControlDraft,
  validateControlDraft,
} from './controlOptions';
import type { AdjustmentResult, ControlOptions, RawEdge } from './types';

const edges: RawEdge[] = [
  { id: 'E1', dx: 10, dy: 0, weight: 1 },
  { id: 'E2', dx: 0, dy: 5, weight: 1 },
  { id: 'E3', dx: -10, dy: 0, weight: 1 },
  { id: 'E4', dx: 0, dy: -4, weight: 1 },
];
// 原始站位：P0(0,0) → P1(10,0) → P2(10,5) → P3(0,5) → P4(0,1)，闭合差 (0,1)

/** 独立逐段复算：从指定起点按段累加原始分量与修正，核对段终点 */
function checkSegmentsIndependent(
  r: AdjustmentResult,
  stations: { endEdge: number; x: number; y: number }[],
) {
  const byEnd = new Map(stations.map((s) => [s.endEdge, s]));
  let x = 0n;
  let y = 0n;
  r.edges.forEach((e, i) => {
    x += BigInt(e.dx) + e.corrX;
    y += BigInt(e.dy) + e.corrY;
    const st = byEnd.get(i);
    if (st) {
      expect(x, `第 ${i + 1} 边终点控制站 x`).toBe(BigInt(st.x));
      expect(y, `第 ${i + 1} 边终点控制站 y`).toBe(BigInt(st.y));
    }
  });
  // 最终终点必须严格回到原点
  expect(x).toBe(0n);
  expect(y).toBe(0n);
}

describe('adjustWithControls — 独立逐段复算', () => {
  it('单控制站：两段分别独立分配，控制站与最终闭合均精确到位', () => {
    // K1 = 第 2 边终点，指定 (10, 6)（比原始 (10,5) 高 1）
    const options: ControlOptions = {
      stations: [{ endEdge: 1, x: 10, y: 6 }],
      lockedEdgeIds: [],
    };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;

    expect(r.segments).toHaveLength(2);
    // 段 1：(0,0)→(10,6)，raw (10,5)，需要修正 (0,+1)
    expect(r.segments![0].requiredCorrX).toBe(0n);
    expect(r.segments![0].requiredCorrY).toBe(1n);
    // 段 2：(10,6)→(0,0)，raw (-10,-4)，需要修正 (0,-2)
    expect(r.segments![1].requiredCorrX).toBe(0n);
    expect(r.segments![1].requiredCorrY).toBe(-2n);

    // 段 2 两条边平分 -2：各 -1
    expect(r.edges[2].corrY).toBe(-1n);
    expect(r.edges[3].corrY).toBe(-1n);
    // 段 1 需 +1，余数相同按 id UTF-8 序 E1 拿 +1
    expect(r.edges[0].corrY).toBe(1n);
    expect(r.edges[1].corrY).toBe(0n);

    // 锁边标记与段号
    expect(r.edges.map((e) => e.locked)).toEqual(
      Array(4).fill(false),
    );
    expect(r.edges.map((e) => e.segmentIndex)).toEqual([0, 0, 1, 1]);

    checkSegmentsIndependent(r, options.stations);
  });

  it('三个控制站：四个区段各自独立修正到指定端点', () => {
    // K1=P1 指定 (11,0)；K2=P2 指定 (11,5)；K3=P3 指定 (0,6)
    const options: ControlOptions = {
      stations: [
        { endEdge: 0, x: 11, y: 0 },
        { endEdge: 1, x: 11, y: 5 },
        { endEdge: 2, x: 0, y: 6 },
      ],
      lockedEdgeIds: [],
    };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;
    expect(r.segments).toHaveLength(4);
    // 段 1（仅 E1）：需 (+1,0)
    expect(r.edges[0].corrX).toBe(1n);
    // 段 2（仅 E2）：(11,0)→(11,5)，E2 原始 (0,5)，需 (0,0)
    expect(r.edges[1].corrX).toBe(0n);
    expect(r.edges[1].corrY).toBe(0n);
    // 段 3（仅 E3）：(11,5)→(0,6)，E3 原始 (-10,0)，需 (-1,+1)
    expect(r.edges[2].corrX).toBe(-1n);
    expect(r.edges[2].corrY).toBe(1n);
    // 段 4（仅 E4）：(0,6)→(0,0)，E4 原始 (0,-4)，需 (0,-2)
    expect(r.edges[3].corrY).toBe(-2n);
    checkSegmentsIndependent(r, options.stations);
  });
});

describe('adjustWithControls — 最终闭合与负修正', () => {
  it('控制站即便改变中间形状，最后终点仍严格为原点；段内可出现负修正', () => {
    const options: ControlOptions = {
      stations: [{ endEdge: 1, x: 10, y: 6 }],
      lockedEdgeIds: [],
    };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;
    const last = r.edges.reduce(
      (p, e) => ({
        x: p.x + Number(e.dx) + Number(e.corrX),
        y: p.y + Number(e.dy) + Number(e.corrY),
      }),
      { x: 0, y: 0 },
    );
    expect(last).toEqual({ x: 0, y: 0 });
    const allCorrY = r.edges.map((e) => e.corrY);
    expect(Math.min(...allCorrY.map(Number))).toBeLessThan(0);
  });

  it('无控制站无锁边时与整网平差数值完全一致（模式仍为 control）', () => {
    const options: ControlOptions = { stations: [], lockedEdgeIds: [] };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;
    expect(r.mode).toBe('control');
    expect(r.segments).toHaveLength(1);
    // 闭合差 fy=1，总修正 -1：4 条等权边各 floor(-1/4)=-1，R=3 个单位
    // 按余数（全等）+UTF-8 序回补给 E1/E2/E3，故 E4 保留 -1
    expect(r.edges.map((e) => e.corrY)).toEqual([0n, 0n, 0n, -1n]);
    expect(r.edges.reduce((s, e) => s + e.corrY, 0n)).toBe(-1n);
    expect(r.edges.every((e) => e.corrX === 0n)).toBe(true);
  });
});

describe('adjustWithControls — 锁边与全锁不可行段', () => {
  it('锁边两轴修正恒为零，未锁边按原权重分摊段修正', () => {
    const weighted: RawEdge[] = [
      { id: 'E1', dx: 10, dy: 0, weight: 1 },
      { id: 'E2', dx: 0, dy: 5, weight: 1 },
      { id: 'E3', dx: -10, dy: 0, weight: 3 },
      { id: 'E4', dx: 0, dy: -4, weight: 1 },
    ];
    const options: ControlOptions = {
      stations: [{ endEdge: 1, x: 10, y: 6 }],
      lockedEdgeIds: ['E1'],
    };
    const out = adjustWithControls(weighted, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;
    // E1 锁死：两轴修正恒 0；段 1 只有 E2 可调，需要 (0,+1)
    expect(r.edges[0].corrX).toBe(0n);
    expect(r.edges[0].corrY).toBe(0n);
    expect(r.edges[0].locked).toBe(true);
    expect(r.edges[1].corrY).toBe(1n);
    // 段 2：E3(权3)、E4(权1) 分 -2
    const seg2 = r.segments![1];
    expect(seg2.lockedEdgeIds).toEqual([]);
    expect(seg2.adjustableEdgeIds).toEqual(['E3', 'E4']);
    expect(seg2.adjustableWeight).toBe(4n);
    checkSegmentsIndependent(r, options.stations);
  });

  it('某段全部锁定且原始位移不满足端点：返回定位该段的不可行结论，不产出结果', () => {
    const options: ControlOptions = {
      stations: [{ endEdge: 1, x: 10, y: 9 }], // 段 1 原始到 (10,5)，需 +4 却全锁
      lockedEdgeIds: ['E1', 'E2'],
    };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(false);
    if (out.feasible) return;
    const bad = out as ControlInfeasible;
    expect(bad.segmentIndex).toBe(0);
    expect(bad.startEdgeNo).toBe(1);
    expect(bad.endEdgeNo).toBe(2);
    expect(bad.residualX).toBe(0n);
    expect(bad.residualY).toBe(4n);
    expect(bad.message).toContain('第 1 段');
    expect(bad.message).toContain('锁边');
    expect(bad.message).toContain('未发布');
  });

  it('全锁段但原始位移恰好满足端点：可行且锁边修正全为 0', () => {
    // 段 1 锁死，指定坐标等于原始站位 (10,5)；段 2 需回到原点
    const options: ControlOptions = {
      stations: [{ endEdge: 1, x: 10, y: 5 }],
      lockedEdgeIds: ['E1', 'E2'],
    };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;
    expect(r.edges[0].corrX).toBe(0n);
    expect(r.edges[0].corrY).toBe(0n);
    expect(r.edges[1].corrX).toBe(0n);
    expect(r.edges[1].corrY).toBe(0n);
    checkSegmentsIndependent(r, options.stations);
  });

  it('末段全锁但回不到原点：定位为最后一段不可行', () => {
    const options: ControlOptions = {
      stations: [{ endEdge: 1, x: 10, y: 6 }],
      lockedEdgeIds: ['E3', 'E4'],
    };
    const out = adjustWithControls(edges, options);
    expect(out.feasible).toBe(false);
    if (out.feasible) return;
    expect(out.segmentIndex).toBe(1);
    expect(out.startEdgeNo).toBe(3);
    expect(out.endEdgeNo).toBe(4);
  });
});

describe('adjustWithControls — 大权重 BigInt 精度', () => {
  it('段内权重取 2^53-1，配额与余数全程 BigInt，段终点精确', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const weighted: RawEdge[] = [
      { id: 'A', dx: 0, dy: 0, weight: 1 },
      { id: 'B', dx: 0, dy: 0, weight: 1 },
      { id: 'C', dx: 0, dy: 0, weight: big },
      { id: 'D', dx: 0, dy: 0, weight: 1 },
    ];
    // K1 = A 后指定 (0,1)：段 1 仅 A 得 +1；段 2（B、C、D）需从 (0,1) 回原点，总修正 -1
    const options: ControlOptions = {
      stations: [{ endEdge: 0, x: 0, y: 1 }],
      lockedEdgeIds: [],
    };
    const out = adjustWithControls(weighted, options);
    expect(out.feasible).toBe(true);
    if (!out.feasible) return;
    const r = out.result;
    expect(r.edges[0].corrY).toBe(1n);
    // 段 2 权重 (1, 2^53-1, 1)：total=-1，C 的 floor(-big/W)=-1 且余数最大，
    // R=2 按余数回补给两条权 1 的边，故 B=0、C=-1、D=0
    expect(r.edges[1].corrY).toBe(0n);
    expect(r.edges[2].corrY).toBe(-1n);
    expect(r.edges[3].corrY).toBe(0n);
    expect(r.segments![1].adjustableWeight).toBe(BigInt(big) + 2n);
    checkSegmentsIndependent(r, options.stations);
  });
});

describe('validateControlDraft — 编辑校验', () => {
  it('重复站位拒绝并给出明确错误', () => {
    const draft = {
      stations: [
        { endEdge: '2', x: '10', y: '6' },
        { endEdge: '2', x: '0', y: '0' },
      ],
      lockedEdgeIds: '',
    };
    const got = validateControlDraft(draft, edges);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain('站位重复');
  });

  it('站位越界（起点/最后终点）拒绝', () => {
    const last = {
      stations: [{ endEdge: '4', x: '0', y: '0' }],
      lockedEdgeIds: '',
    };
    expect(validateControlDraft(last, edges).ok).toBe(false);
    const first = {
      stations: [{ endEdge: '0', x: '0', y: '0' }],
      lockedEdgeIds: '',
    };
    expect(validateControlDraft(first, edges).ok).toBe(false);
  });

  it('坐标非整数/超界拒绝；超过三个控制站拒绝', () => {
    expect(
      validateControlDraft(
        { stations: [{ endEdge: '2', x: '1.5', y: '0' }], lockedEdgeIds: '' },
        edges,
      ).ok,
    ).toBe(false);
    expect(
      validateControlDraft(
        { stations: [{ endEdge: '2', x: '200000001', y: '0' }], lockedEdgeIds: '' },
        edges,
      ).ok,
    ).toBe(false);
    expect(
      validateControlDraft(
        {
          stations: [1, 2, 3, 4].map((n) => ({
            endEdge: String(n),
            x: '0',
            y: '0',
          })),
          lockedEdgeIds: '',
        },
        edges,
      ).ok,
    ).toBe(false);
  });

  it('未知锁边 id 拒绝；合法时锁边去重并按边顺序规范化', () => {
    const bad = validateControlDraft(
      { stations: [], lockedEdgeIds: 'E4, NOPE' },
      edges,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('NOPE');

    const good = validateControlDraft(
      { stations: [], lockedEdgeIds: 'E4, E2, E4' },
      edges,
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.options.lockedEdgeIds).toEqual(['E2', 'E4']);
    }
  });

  it('空草稿合法且指纹稳定；同一配置不同顺序指纹相同（过期判定口径）', () => {
    expect(validateControlDraft(emptyControlDraft(), edges).ok).toBe(true);
    const a = controlOptionsKey({
      stations: [{ endEdge: 1, x: 10, y: 6 }],
      lockedEdgeIds: ['E2', 'E4'],
    });
    const b = controlOptionsKey({
      stations: [{ endEdge: 1, x: 10, y: 6 }],
      lockedEdgeIds: ['E4', 'E2'],
    });
    expect(a).toBe(b);
  });
});
