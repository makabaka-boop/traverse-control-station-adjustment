import { describe, expect, it } from 'vitest';
import { stringifyResult } from './export';
import { adjustTraverse } from '../core/adjustment';
import type { RawEdge } from '../core/types';

describe('schema/1 字节级契约快照', () => {
  it('常规平差 JSON 与旧格式逐字节一致', () => {
    const edges: RawEdge[] = [
      { id: 'a', dx: 5, dy: 7, weight: 2 },
      { id: 'b', dx: -3, dy: -2, weight: 1 },
      { id: 'c', dx: -1, dy: -4, weight: 1 },
    ];
    const json = stringifyResult(adjustTraverse(edges));
    expect(json).toBe(`{
  "schema": "traverse-adjustment/1",
  "closure": {
    "x": 1,
    "y": 1
  },
  "totalWeight": 4,
  "totalWeightExact": "4",
  "edges": [
    {
      "id": "a",
      "dx": 5,
      "dy": 7,
      "weight": 2,
      "corrX": -1,
      "corrY": -1,
      "adjustedDx": 4,
      "adjustedDy": 6
    },
    {
      "id": "b",
      "dx": -3,
      "dy": -2,
      "weight": 1,
      "corrX": 0,
      "corrY": 0,
      "adjustedDx": -3,
      "adjustedDy": -2
    },
    {
      "id": "c",
      "dx": -1,
      "dy": -4,
      "weight": 1,
      "corrX": 0,
      "corrY": 0,
      "adjustedDx": -1,
      "adjustedDy": -4
    }
  ]
}`);
  });
});
