import { allocateLargestRemainder } from './allocation';
import type {
  AdjustmentResult,
  ControlOptions,
  ControlStation,
  EdgeAdjustment,
  RawEdge,
  SegmentInfo,
} from './types';

export interface ControlInfeasible {
  feasible: false;
  /** 不可行区段序号（0 基），页面据此定位 */
  segmentIndex: number;
  /** 段内边范围（边序号，1 基，便于外业定位） */
  startEdgeNo: number;
  endEdgeNo: number;
  /** 没有可调边时各轴的残差（必须为 0 才可行） */
  residualX: bigint;
  residualY: bigint;
  message: string;
}

export type ControlAdjustmentOutcome =
  | { feasible: true; result: AdjustmentResult }
  | ControlInfeasible;

interface SegmentBoundary {
  /** 段内首边下标（0 基） */
  start: number;
  /** 段内末边下标（0 基），其终点即本段指定端点 */
  end: number;
  /** 本段终点控制站序号；末段回到原点时为 null */
  stationIndex: number | null;
  toX: bigint;
  toY: bigint;
}

/**
 * 控制站把整圈切成连续区段：原点 → 控制站 1 → … → 控制站 k → 原点。
 * 段边界按控制站站位（endEdge 升序，调用方已保证互异）划分。
 */
function buildBoundaries(
  edges: RawEdge[],
  stations: ControlStation[],
): SegmentBoundary[] {
  const boundaries: SegmentBoundary[] = [];
  let cursor = 0;
  stations.forEach((st, i) => {
    boundaries.push({
      start: cursor,
      end: st.endEdge,
      stationIndex: i,
      toX: BigInt(st.x),
      toY: BigInt(st.y),
    });
    cursor = st.endEdge + 1;
  });
  // 末段：最后一个控制站（或原点）→ 原点
  boundaries.push({
    start: cursor,
    end: edges.length - 1,
    stationIndex: null,
    toX: 0n,
    toY: 0n,
  });
  return boundaries;
}

/**
 * 控制站平差：
 * - 起点与最后终点固定为原点，中间控制站固定在独立仪器定准的坐标，原值保留；
 * - 控制站把整圈切成连续区段，每段分别计算达到指定端点所需的 x/y 修正总额；
 * - 只让未锁边按原权重、BigInt 欧几里得商余数和 UTF-8 并列规则分配（复用同一分配器）；
 * - 锁边两轴修正恒为零，不参与分配；
 * - 某段没有可调边而原始位移不满足端点时，返回定位该段的不可行结论，
 *   调用方不得发布任何部分新图。
 */
export function adjustWithControls(
  edges: RawEdge[],
  options: ControlOptions,
): ControlAdjustmentOutcome {
  // 防御性自检：该函数也可被直接调用，调用方必须满足控制参数约束
  if (options.stations.length > 3) {
    throw new Error('控制站平差失败：中间控制站最多 3 个');
  }
  const knownIds = new Set(edges.map((e) => e.id));
  for (const id of options.lockedEdgeIds) {
    if (!knownIds.has(id)) throw new Error(`控制站平差失败：未知锁边 id「${id}」`);
  }
  const stations = [...options.stations].sort((a, b) => a.endEdge - b.endEdge);
  let prevEnd = -1;
  for (const st of stations) {
    if (!Number.isSafeInteger(st.endEdge) || st.endEdge <= prevEnd) {
      throw new Error('控制站平差失败：控制站站位必须互异且按序排列');
    }
    if (st.endEdge < 0 || st.endEdge >= edges.length - 1) {
      throw new Error('控制站平差失败：控制站站位必须是中间终点（不含起点与最后终点）');
    }
    prevEnd = st.endEdge;
  }
  const normalizedLocked = [...new Set(options.lockedEdgeIds)];

  const closureX = edges.reduce((s, e) => s + BigInt(e.dx), 0n);
  const closureY = edges.reduce((s, e) => s + BigInt(e.dy), 0n);
  const totalWeight = edges.reduce((s, e) => s + BigInt(e.weight), 0n);
  const locked = new Set(normalizedLocked);
  const boundaries = buildBoundaries(edges, stations);

  const segments: SegmentInfo[] = [];
  const corrX = new Array<bigint>(edges.length).fill(0n);
  const corrY = new Array<bigint>(edges.length).fill(0n);

  let fromX = 0n;
  let fromY = 0n;

  for (let si = 0; si < boundaries.length; si++) {
    const b = boundaries[si];
    const slice = edges.slice(b.start, b.end + 1);
    const rawX = slice.reduce((s, e) => s + BigInt(e.dx), 0n);
    const rawY = slice.reduce((s, e) => s + BigInt(e.dy), 0n);
    // 段修正总额：指定端点 − 段起点 − 原始位移
    const requiredCorrX = b.toX - fromX - rawX;
    const requiredCorrY = b.toY - fromY - rawY;

    const adjustable: RawEdge[] = [];
    const adjustableGlobalIdx: number[] = [];
    const lockedInSegment: string[] = [];
    for (let i = b.start; i <= b.end; i++) {
      if (locked.has(edges[i].id)) lockedInSegment.push(edges[i].id);
      else {
        adjustable.push(edges[i]);
        adjustableGlobalIdx.push(i);
      }
    }
    const adjustableWeight = adjustable.reduce(
      (s, e) => s + BigInt(e.weight),
      0n,
    );

    // 无可调边：锁边修正恒零，位移必须恰好满足端点，否则该段不可行
    if (adjustable.length === 0) {
      if (requiredCorrX !== 0n || requiredCorrY !== 0n) {
        const message =
          `第 ${si + 1} 段（第 ${b.start + 1}–${b.end + 1} 条边）全部为锁边，` +
          `无可调边，原始位移不满足指定端点` +
          `（x 残差 ${requiredCorrX.toString()} mm、y 残差 ${requiredCorrY.toString()} mm），` +
          '该段不可行，未发布任何部分新图';
        return {
          feasible: false,
          segmentIndex: si,
          startEdgeNo: b.start + 1,
          endEdgeNo: b.end + 1,
          residualX: requiredCorrX,
          residualY: requiredCorrY,
          message,
        };
      }
    } else {
      const weighted = adjustable.map((e) => ({
        id: e.id,
        weight: BigInt(e.weight),
      }));
      // 两轴独立分配，口径与整网平差完全一致（floor 商/余数/UTF-8 决胜）
      const allocX = allocateLargestRemainder(weighted, requiredCorrX);
      const allocY = allocateLargestRemainder(weighted, requiredCorrY);
      allocX.forEach((row, k) => {
        corrX[adjustableGlobalIdx[k]] = row.amount;
      });
      allocY.forEach((row, k) => {
        corrY[adjustableGlobalIdx[k]] = row.amount;
      });
    }

    segments.push({
      index: si,
      startEdgeIndex: b.start,
      endEdgeIndex: b.end,
      endStationIndex: b.stationIndex,
      fromX,
      fromY,
      toX: b.toX,
      toY: b.toY,
      rawX,
      rawY,
      requiredCorrX,
      requiredCorrY,
      adjustableEdgeIds: adjustable.map((e) => e.id),
      lockedEdgeIds: lockedInSegment,
      adjustableWeight,
    });

    fromX = b.toX;
    fromY = b.toY;
  }

  const segmentIndexOf = new Map<number, number>();
  segments.forEach((s) => {
    for (let i = s.startEdgeIndex; i <= s.endEdgeIndex; i++) {
      segmentIndexOf.set(i, s.index);
    }
  });
  const out: EdgeAdjustment[] = edges.map((e, i) => ({
    ...e,
    corrX: corrX[i],
    corrY: corrY[i],
    segmentIndex: segmentIndexOf.get(i),
    locked: locked.has(e.id),
  }));

  // 硬性不变量：每个控制站与最终终点都必须精确落在指定坐标（BigInt 严格相等）
  const stationByEnd = new Map(stations.map((st) => [st.endEdge, st]));
  let px = 0n;
  let py = 0n;
  for (let i = 0; i < out.length; i++) {
    px += BigInt(out[i].dx) + out[i].corrX;
    py += BigInt(out[i].dy) + out[i].corrY;
    const st = stationByEnd.get(i);
    if (st && (px !== BigInt(st.x) || py !== BigInt(st.y))) {
      throw new Error('控制站平差不变量失败：控制站未精确落在指定坐标');
    }
  }
  if (px !== 0n || py !== 0n) {
    throw new Error('控制站平差不变量失败：最终终点未回到原点');
  }

  return {
    feasible: true,
    result: {
      closureX,
      closureY,
      totalWeight,
      edges: out,
      mode: 'control',
      controls: stations.map((s) => ({ ...s })),
      lockedEdgeIds: [...normalizedLocked],
      segments,
    },
  };
}
