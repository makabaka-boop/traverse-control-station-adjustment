/** 原始顺序边：坐标分量为整数毫米，weight 为正整数权重 */
export interface RawEdge {
  id: string;
  dx: number;
  dy: number;
  weight: number;
}

/** 单边平差结果：corrX/corrY 为按权重最大余数法分配到的整数修正量 */
export interface EdgeAdjustment extends RawEdge {
  corrX: bigint;
  corrY: bigint;
}

export interface AdjustmentResult {
  /** 闭合差 f = Σ 原始分量 */
  closureX: bigint;
  closureY: bigint;
  totalWeight: bigint;
  edges: EdgeAdjustment[];
}

/**
 * 中间控制站：vertexIndex 为顶点序号 v_k（1 ≤ k ≤ n−1），
 * 即有序边中第 k 条边（1-based）的终点；x/y 为相对起点 v0 的整数毫米坐标。
 */
export interface ControlStation {
  vertexIndex: number;
  x: number;
  y: number;
}

/** 已采纳的控制站平差配置：stations 按 vertexIndex 升序、互异，至多 3 个 */
export interface ControlConfig {
  stations: ControlStation[];
  /** 封存观测边 id：两轴修正恒为 0 */
  lockedEdgeIds: string[];
}

/** 编辑态控制站单行：坐标保留文本，未采纳前允许非法输入 */
export interface ControlStationDraft {
  vertexIndex: number | null;
  x: string;
  y: string;
}

export interface ControlDraft {
  stations: ControlStationDraft[];
  lockedEdgeIds: string[];
}

/** 单个连续区段的平差详情（端点固定，修正只在未锁边间分配） */
export interface SegmentAdjustment {
  /** 区段序号（0-based，沿行进方向） */
  index: number;
  fromVertex: number;
  toVertex: number;
  fromX: bigint;
  fromY: bigint;
  toX: bigint;
  toY: bigint;
  /** 段内原始位移 Σ 原始分量 */
  rawX: bigint;
  rawY: bigint;
  /** 到指定端点尚缺的修正总量 = (to−from)−raw */
  needX: bigint;
  needY: bigint;
  /** 段内可调边（未锁）权重和 */
  totalWeight: bigint;
  adjustableEdgeIds: string[];
  lockedEdgeIds: string[];
}

/** 控制站平差结果：与普通结果复用同一组 edges/闭合差字段，另附区段信息 */
export interface ControlledAdjustmentResult extends AdjustmentResult {
  controlStations: ControlStation[];
  lockedEdgeIds: string[];
  segments: SegmentAdjustment[];
}

/** 不可行定位：某区段无可调边而原始位移不满足固定端点 */
export interface InfeasibleSegment {
  segmentIndex: number;
  fromVertex: number;
  toVertex: number;
  fromX: bigint;
  fromY: bigint;
  toX: bigint;
  toY: bigint;
  rawX: bigint;
  rawY: bigint;
  needX: bigint;
  needY: bigint;
  adjustableEdgeIds: string[];
  lockedEdgeIds: string[];
}

export type ControlledAdjustmentOutcome =
  | { ok: true; result: ControlledAdjustmentResult }
  | { ok: false; infeasible: InfeasibleSegment };

export type AnyAdjustmentResult = AdjustmentResult | ControlledAdjustmentResult;

export function isControlledResult(
  r: AnyAdjustmentResult,
): r is ControlledAdjustmentResult {
  return 'segments' in r;
}
