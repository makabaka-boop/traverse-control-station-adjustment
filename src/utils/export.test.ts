import { describe, expect, it } from 'vitest';
import { stringifyResult } from './export';
import { adjustTraverse } from '../core/adjustment';
import type { RawEdge } from '../core/types';

describe('stringifyResult', () => {
  it('BigInt 字段以精确无引号整数字面量输出，且可被 JSON.parse 读回', () => {
    const edges: RawEdge[] = [
      { id: 'a', dx: 5, dy: 7, weight: 2 },
      { id: 'b', dx: -3, dy: -2, weight: 1 },
      { id: 'c', dx: -1, dy: -4, weight: 1 },
    ];
    const json = stringifyResult(adjustTraverse(edges));
    const parsed = JSON.parse(json) as {
      closure: { x: number; y: number };
      totalWeight: number | null;
      totalWeightExact: string;
      edges: Array<{ corrX: number; adjustedDx: number }>;
    };
    expect(parsed.closure.x).toBe(1);
    expect(parsed.closure.y).toBe(1);
    expect(parsed.totalWeight).toBe(4);
    expect(parsed.totalWeightExact).toBe('4');
    const sumX = parsed.edges.reduce((s, e) => s + e.adjustedDx, 0);
    expect(sumX).toBe(0);
  });

  it('总权重超过 2^53 时数值字段为 null，精确字符串逐位保留', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const edges: RawEdge[] = [
      { id: 'A', dx: 1, dy: 0, weight: big },
      { id: 'B', dx: 0, dy: 0, weight: big },
      { id: 'C', dx: 0, dy: 0, weight: 1 },
    ];
    const r = adjustTraverse(edges);
    expect(r.totalWeight > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    const json = stringifyResult(r);
    const parsed = JSON.parse(json) as {
      totalWeight: number | null;
      totalWeightExact: string;
    };
    expect(parsed.totalWeight).toBeNull();
    expect(parsed.totalWeightExact).toBe((BigInt(big) * 2n + 1n).toString());
    // 文本中包含精确字面量（无引号）
    expect(json).toContain(`"totalWeightExact": "${BigInt(big) * 2n + 1n}"`);
  });

  it('旧数组输入（普通平差）导出契约不变：无 mode/controls/segments/locked 字段，边记录仅 8 个旧键', () => {
    const edges: RawEdge[] = [
      { id: 'a', dx: 5, dy: 7, weight: 2 },
      { id: 'b', dx: -3, dy: -2, weight: 1 },
      { id: 'c', dx: -1, dy: -4, weight: 1 },
    ];
    const parsed = JSON.parse(stringifyResult(adjustTraverse(edges))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual(
      ['closure', 'edges', 'schema', 'totalWeight', 'totalWeightExact'].sort(),
    );
    expect('mode' in parsed).toBe(false);
    expect('controls' in parsed).toBe(false);
    expect('segments' in parsed).toBe(false);
    expect('lockedEdgeIds' in parsed).toBe(false);
    const firstEdge = parsed.edges as Array<Record<string, unknown>>;
    expect(Object.keys(firstEdge[0]).sort()).toEqual(
      ['adjustedDx', 'adjustedDy', 'corrX', 'corrY', 'dx', 'dy', 'id', 'weight'].sort(),
    );
  });
});
