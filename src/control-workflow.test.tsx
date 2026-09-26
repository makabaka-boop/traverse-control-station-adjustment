import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

// 原始：P0(0,0)→P1(10,0)→P2(10,5)→P3(0,5)→P4(0,1)，闭合差 (0,1)
const inputJson = JSON.stringify([
  { id: 'E1', dx: 10, dy: 0, weight: 1 },
  { id: 'E2', dx: 0, dy: 5, weight: 1 },
  { id: 'E3', dx: -10, dy: 0, weight: 1 },
  { id: 'E4', dx: 0, dy: -4, weight: 1 },
]);

/** 足够的 2D 上下文桩：属性可写、绘图方法均为空操作 */
function makeFake2d() {
  return new Proxy(
    {},
    {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return () => {};
      },
      set(target, prop: string | symbol, value) {
        (target as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

let jsonContents: string[] = [];

async function readLastJson(): Promise<{
  parsed: any;
  raw: string;
}> {
  const raw = jsonContents[jsonContents.length - 1];
  return { parsed: JSON.parse(raw), raw };
}

function runBaseAdjustment() {
  fireEvent.change(screen.getByLabelText('顺序边 JSON 输入'), { target: { value: inputJson } });
  fireEvent.click(screen.getByRole('button', { name: '执行平差' }));
}

function addStation() {
  fireEvent.click(screen.getByTestId('add-station'));
}

function setStation(
  i: number,
  fields: { endEdge?: string; x?: string; y?: string },
) {
  if (fields.endEdge !== undefined)
    fireEvent.change(screen.getByLabelText(`控制站 ${i + 1} 站位（边序号）`), {
      target: { value: fields.endEdge },
    });
  if (fields.x !== undefined)
    fireEvent.change(screen.getByLabelText(`控制站 ${i + 1} x 坐标`), {
      target: { value: fields.x },
    });
  if (fields.y !== undefined)
    fireEvent.change(screen.getByLabelText(`控制站 ${i + 1} y 坐标`), {
      target: { value: fields.y },
    });
}

function setLocks(text: string) {
  fireEvent.change(screen.getByLabelText('锁定边 id 列表'), {
    target: { value: text },
  });
}

/** 从渲染后的表格逐行读出 (平差后dx, 平差后dy)，累计各顶点坐标 */
function cumulativeFromTable(): Array<[number, number]> {
  const rows = screen
    .getAllByRole('row')
    .slice(1, -1) // 去表头、合计
    .map((tr) => tr.querySelectorAll('td'));
  const pts: Array<[number, number]> = [[0, 0]];
  let x = 0;
  let y = 0;
  rows.forEach((tds) => {
    // 控制模式列顺序：0# 1id 2dx 3dy 4weight 5段 6锁 7corrX 8corrY 9adjX 10adjY
    const ax = Number(tds[tds.length - 2].textContent!.replace(/,/g, ''));
    const ay = Number(tds[tds.length - 1].textContent!.replace(/,/g, ''));
    x += ax;
    y += ay;
    pts.push([x, y]);
  });
  return pts;
}

beforeEach(() => {

  jsonContents = [];
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, value: 480 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(makeFake2d());
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    cb: (blob: Blob | null) => void,
  ) {
    cb(new Blob(['png'], { type: 'image/png' }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  // 捕获 JSON/PNG 导出实际发布的 Blob 内容
  const RealBlob = globalThis.Blob;
  vi.spyOn(globalThis, 'Blob').mockImplementation((parts?: BlobPart[], opts?: BlobPropertyBag) => {
    const b = new RealBlob(parts as BlobPart[] | undefined, opts);
    if (opts?.type === 'application/json') {
      jsonContents.push((parts ?? []).map((p) => String(p)).join(''));
    }
    return b;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('页面：控制站编辑 → 平差 → 导出', () => {
  it('编辑控制站并采纳：表格各顶点经过控制站、最终回原点，JSON 导出复用同一结果', async () => {
    render(<App />);
    runBaseAdjustment();
    expect(screen.getByTestId('sum-adjusted-x').textContent).toBe('0');
    expect(screen.queryByTestId('control-editor')).toBeTruthy();

    addStation();
    // K1 = 第 2 边终点 (10,6)
    setStation(0, { endEdge: '2', x: '10', y: '6' });
    fireEvent.click(screen.getByTestId('apply-control'));

    // 状态切换为控制平差
    await waitFor(() =>
      expect(screen.getByText(/控制平差·1 站/)).toBeTruthy(),
    );

    const pts = cumulativeFromTable();
    expect(pts).toHaveLength(5);
    expect(pts[2]).toEqual([10, 6]); // K1 精确到位
    expect(pts[4]).toEqual([0, 0]); // 最终终点严格回原点

    // 表格合计仍为 0
    expect(screen.getByTestId('sum-adjusted-x').textContent).toBe('0');
    expect(screen.getByTestId('sum-adjusted-y').textContent).toBe('0');

    // 导出 JSON：与页面表格同源（同一份结果）
    fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
    await waitFor(() => expect(jsonContents.length).toBeGreaterThan(0));
    const { parsed } = await readLastJson();
    expect(parsed.mode).toBe('control');
    expect(parsed.controls).toEqual([{ endEdgeNo: 2, x: 10, y: 6 }]);
    expect(parsed.segments).toHaveLength(2);
    // 段 1 需要 y 修正 +1，段 2 需要 -2
    expect(parsed.segments[0].requiredCorrection).toEqual({ x: 0, y: 1 });
    expect(parsed.segments[1].requiredCorrection).toEqual({ x: 0, y: -2 });

    // 导出值与表格逐行一致（同一份结果，不允许分叉）
    parsed.edges.forEach(
      (
        e: { adjustedDx: number; adjustedDy: number },
        i: number,
      ) => {
        const rows = screen.getAllByRole('row').slice(1, -1);
        const tds = rows[i].querySelectorAll('td');
        expect(Number(tds[tds.length - 2].textContent!.replace(/,/g, ''))).toBe(
          e.adjustedDx,
        );
        expect(Number(tds[tds.length - 1].textContent!.replace(/,/g, ''))).toBe(
          e.adjustedDy,
        );
      },
    );
  });

  it('锁边两轴修正为零并在表格标注；JSON 中 locked=true', async () => {
    render(<App />);
    runBaseAdjustment();
    addStation();
    setStation(0, { endEdge: '2', x: '10', y: '6' });
    setLocks('E1');
    fireEvent.click(screen.getByTestId('apply-control'));
    await waitFor(() =>
      expect(screen.getByText(/控制平差·1 站 1 锁/)).toBeTruthy(),
    );

    const rows = screen.getAllByRole('row').slice(1, -1);
    const first = rows[0].querySelectorAll('td');
    // E1 锁边：两轴修正列（倒数第 4、3）为 0
    expect(first[first.length - 4].textContent).toBe('0');
    expect(first[first.length - 3].textContent).toBe('0');
    expect(first[first.length - 5].textContent).toContain('锁边');

    fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
    await waitFor(() => expect(jsonContents.length).toBeGreaterThan(0));
    const { parsed } = await readLastJson();
    expect(parsed.edges[0].locked).toBe(true);
    expect(parsed.edges[0].corrX).toBe(0);
    expect(parsed.edges[0].corrY).toBe(0);
    expect(parsed.lockedEdgeIds).toEqual(['E1']);
  });

  it('非法编辑（重复站位）不覆盖已采纳结果，且明确标记过期', async () => {
    render(<App />);
    runBaseAdjustment();
    addStation();
    setStation(0, { endEdge: '2', x: '10', y: '6' });
    fireEvent.click(screen.getByTestId('apply-control'));
    await waitFor(() =>
      expect(screen.getByText(/控制平差·1 站/)).toBeTruthy(),
    );

    // 已采纳后再加一个重复站位（都选第 2 边终点）
    addStation();
    // 新增行默认站位为 1，改成 2 造成重复
    setStation(1, { endEdge: '2', x: '0', y: '0' });
    fireEvent.click(screen.getByTestId('apply-control'));

    const err = await screen.findByTestId('control-error');
    expect(err.textContent).toContain('站位重复');

    // 画面/导出仍是上次采纳结果：一个控制站
    fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
    await waitFor(() => expect(jsonContents.length).toBeGreaterThan(0));
    const { parsed } = await readLastJson();
    expect(parsed.controls).toHaveLength(1);
  });

  it('草稿与已采纳结果不一致即出现过期标记，恢复普通平差后消失', async () => {
    render(<App />);
    runBaseAdjustment();
    addStation();
    setStation(0, { endEdge: '2', x: '10', y: '6' });
    fireEvent.click(screen.getByTestId('apply-control'));
    await waitFor(() =>
      expect(screen.getByText(/控制平差·1 站/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('control-stale')).toBeNull();

    // 改动坐标但不采纳
    setStation(0, { y: '7' });
    expect((await screen.findByTestId('control-stale')).textContent).toContain(
      '过期',
    );

    // 恢复普通平差：控制列消失，合计仍为 0
    fireEvent.click(screen.getByTestId('revert-control'));
    await waitFor(() =>
      expect(screen.queryByTestId('control-stale')).toBeNull(),
    );
    const headerCells = document.querySelectorAll('thead th');
    expect(
      Array.from(headerCells).some((th) => th.textContent === '区段'),
    ).toBe(false);
    expect(screen.getByTestId('sum-adjusted-x').textContent).toBe('0');
  });

  it('全锁区段不可行：提示定位区段且不发布部分新图（导出仍为旧结果）', async () => {
    render(<App />);
    runBaseAdjustment();
    addStation();
    // K1=(10,9) 且 E1/E2 全锁 → 段 1 需要 +4 却无可调边
    setStation(0, { endEdge: '2', x: '10', y: '9' });
    setLocks('E1, E2');
    fireEvent.click(screen.getByTestId('apply-control'));

    const bad = await screen.findByTestId('control-infeasible');
    expect(bad.textContent).toContain('第 1 段');
    expect(bad.textContent).toContain('未发布');

    // 下载 JSON 仍是普通整网平差结果（未切换到控制模式）
    fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
    await waitFor(() => expect(jsonContents.length).toBeGreaterThan(0));
    const { parsed } = await readLastJson();
    expect(parsed.mode).toBeUndefined();
  });
});
