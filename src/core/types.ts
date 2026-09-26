/** 原始顺序边：坐标分量为整数毫米，weight 为正整数权重 */
export interface RawEdge {
  id: string;
  dx: number;
  dy: number;
  weight: number;
}

/**
 * 中间控制站：已由独立仪器定准、必须原值保留的站位。
 * endEdge 为边数组下标（0 基），表示该边终点即控制站；
 * x/y 为相对起点（原点）的指定整数毫米坐标。
 * 起点（边之前）与最后终点（最后一条边之后）恒为原点，不在此列。
 */
export interface ControlStation {
  endEdge: number;
  x: number;
  y: number;
}

/** 控制站平差参数：互异中间控制站（按 endEdge 升序）+ 按边 ID 锁定的封存观测边 */
export interface ControlOptions {
  stations: ControlStation[];
  lockedEdgeIds: string[];
}

/** 单边平差结果：corrX/corrY 为按权重最大余数法分配到的整数修正量 */
export interface EdgeAdjustment extends RawEdge {
  corrX: bigint;
  corrY: bigint;
  /** 控制站平差下所属区段（0 基）；普通平差为 undefined */
  segmentIndex?: number;
  /** 控制站平差下是否为封存锁边（两轴修正恒为 0）；普通平差为 undefined */
  locked?: boolean;
}

/** 一个连续区段的分配明细（控制站把整圈切成的段） */
export interface SegmentInfo {
  /** 区段序号（0 基） */
  index: number;
  /** 段内第一条边在边数组中的下标（0 基） */
  startEdgeIndex: number;
  /** 段内最后一条边在边数组中的下标（0 基），其终点即本段指定端点 */
  endEdgeIndex: number;
  /** 本段终点对应的控制站序号（0 基）；末段回到原点时为 null */
  endStationIndex: number | null;
  /** 本段起点指定坐标（原点或上一个控制站） */
  fromX: bigint;
  fromY: bigint;
  /** 本段终点指定坐标（控制站坐标；末段为原点） */
  toX: bigint;
  toY: bigint;
  /** 段内原始分量之和 */
  rawX: bigint;
  rawY: bigint;
  /** 为达到指定端点，本段两轴还需的修正总额 */
  requiredCorrX: bigint;
  requiredCorrY: bigint;
  /** 段内参与分配的未锁边 ID（保持边数组顺序） */
  adjustableEdgeIds: string[];
  /** 段内锁边 ID（保持边数组顺序） */
  lockedEdgeIds: string[];
  /** 段内未锁边权重和（BigInt，可能超过 2^53） */
  adjustableWeight: bigint;
}

export interface AdjustmentResult {
  /** 闭合差 f = Σ 原始分量（整圈口径，两种模式一致） */
  closureX: bigint;
  closureY: bigint;
  totalWeight: bigint;
  edges: EdgeAdjustment[];
  /** 平差模式：缺省视为普通整网平差（旧契约） */
  mode?: 'plain' | 'control';
  /** 控制站平差下已采纳的控制站（按 endEdge 升序）与锁边 */
  controls?: ControlStation[];
  lockedEdgeIds?: string[];
  segments?: SegmentInfo[];
}
