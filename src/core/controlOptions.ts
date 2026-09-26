import type { ControlOptions, ControlStation, RawEdge } from './types';

/** 页面编辑态：每个控制站一行；站位与坐标以文本录入，锁边为逗号分隔 id */
export interface ControlDraft {
  stations: Array<{ endEdge: string; x: string; y: string }>;
  lockedEdgeIds: string;
}

export type ControlDraftOutcome =
  | { ok: true; options: ControlOptions; key: string }
  | { ok: false; error: string };

/** 空草稿（未配置任何控制站或锁边） */
export function emptyControlDraft(): ControlDraft {
  return { stations: [], lockedEdgeIds: '' };
}

/**
 * 控制站坐标允许范围：中间站位坐标由累计分量形成，
 * 200 条边每条 |分量| ≤ 10⁶，故 |累计| ≤ 2×10⁸，要求安全整数即可逐毫米复算。
 */
const COORD_LIMIT = 200_000_000;

function parseIntegerField(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || Math.abs(n) > COORD_LIMIT) return null;
  return n;
}

/**
 * 解析并严格校验控制站编辑：
 * - 最多三个控制站，站位（边终点序号，1 基输入）必须落在中间终点内
 *   （起点与最后终点恒为原点，不可作为中间控制站）；
 * - 站位互异（重复站位拒绝，不覆盖已采纳结果）；
 * - x/y 为相对起点的整数毫米坐标；
 * - 锁边 id 必须存在于当前边列表，未知/空 id 拒绝；自动去重并按边顺序排列。
 * 校验通过时返回规范化后的 ControlOptions 及可比较的草稿指纹 key。
 */
export function validateControlDraft(
  draft: ControlDraft,
  edges: RawEdge[],
): ControlDraftOutcome {
  if (draft.stations.length > 3) {
    return { ok: false, error: '中间控制站最多指定 3 个' };
  }

  const stations: ControlStation[] = [];
  const seenEnds = new Set<number>();
  const lastEndNo = edges.length; // 1 基：最后一条边终点（=原点）不可选
  for (let i = 0; i < draft.stations.length; i++) {
    const row = draft.stations[i];
    const label = `第 ${i + 1} 个控制站`;

    const endNo = parseIntegerField(row.endEdge);
    if (endNo === null) {
      return { ok: false, error: `${label}的站位（边序号）必须填写整数` };
    }
    if (endNo < 1 || endNo >= lastEndNo) {
      return {
        ok: false,
        error: `${label}的站位必须是第 1 至第 ${lastEndNo - 1} 条边的终点`,
      };
    }
    const endEdge = endNo - 1;
    if (seenEnds.has(endEdge)) {
      return {
        ok: false,
        error: `${label}与前面的控制站站位重复（第 ${endNo} 条边终点），站位必须互异`,
      };
    }
    seenEnds.add(endEdge);

    const x = parseIntegerField(row.x);
    if (x === null) {
      return { ok: false, error: `${label}的 x 坐标必须是绝对值不超过 2×10⁸ 的整数` };
    }
    const y = parseIntegerField(row.y);
    if (y === null) {
      return { ok: false, error: `${label}的 y 坐标必须是绝对值不超过 2×10⁸ 的整数` };
    }
    stations.push({ endEdge, x, y });
  }

  const knownIds = new Set(edges.map((e) => e.id));
  const tokens = draft.lockedEdgeIds
    .split(/[，,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const lockedSet = new Set<string>();
  for (const tok of tokens) {
    if (!knownIds.has(tok)) {
      return { ok: false, error: `锁边 id「${tok}」不存在，请使用当前边列表中的 id` };
    }
    lockedSet.add(tok);
  }
  // 规范化：按边数组顺序排列锁边，控制站按站位升序
  const lockedEdgeIds = edges.map((e) => e.id).filter((id) => lockedSet.has(id));
  stations.sort((a, b) => a.endEdge - b.endEdge);

  const options = { stations, lockedEdgeIds };
  return { ok: true, options, key: controlOptionsKey(options) };
}

/**
 * 已采纳控制参数的规范化指纹：用于判断编辑草稿是否已过期。
 * 非法草稿不会产生 key（调用方用 invalid: 前缀），因此非法编辑永不匹配已采纳结果。
 */
export function controlOptionsKey(options: ControlOptions): string {
  const s = [...options.stations]
    .sort((a, b) => a.endEdge - b.endEdge)
    .map((st) => `${st.endEdge}:${st.x},${st.y}`)
    .join(';');
  const l = [...options.lockedEdgeIds].sort().join(',');
  return `s=${s}|l=${l}`;
}
