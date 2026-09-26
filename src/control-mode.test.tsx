import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import {
  canvasResultSignature,
  resultSignature,
} from './components/TraverseChart';
import { adjustTraverseControlled } from './core/control';
import type { RawEdge } from './core/types';

/**
 * 页面级验收：控制站平差模式从编辑到导出。
 * 画布置于 jsdom 桩环境（与 export-acceptance 同一套手法），
 * JSON 导出通过 URL.createObjectURL 捕获 Blob 内容逐字段核对。
 */

const edges5: RawEdge[] = [
  { id: 'E1', dx: 200, dy: 0, weight: 1 },
  { id: 'E2', dx: 200, dy: 0, weight: 1 },
  { id: 'E3', dx: 100, dy: 0, weight: 1 },
  { id: 'E4', dx: 0, dy: 100, weight: 1 },
  { id: 'E5', dx: -500, dy: -100, weight: 1 },
];
const input5 = JSON.stringify(edges5);

/** 记录 fillText 的 2D 上下文桩：用于确认控制站被叠画上屏 */
const drawnTexts: string[] = [];
function makeRecordingFake2d() {
  return new Proxy(
    {},
    {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'fillText') {
          return (text: unknown) => {
            drawnTexts.push(String(text));
          };
        }
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

function setCanvasCssSize(w: number, h: number) {
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'clientWidth', { configurable: true, value: w });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, value: h });
}

let capturedJson: string | null;

async function blobToText(blob: Blob): Promise<string> {
  const withText = blob as Blob & { text?: () => Promise<string> };
  if (typeof withText.text === 'function') return withText.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

function runAdjustment(json: string) {
  fireEvent.change(screen.getByLabelText('顺序边 JSON'), {
    target: { value: json },
  });
  fireEvent.click(screen.getByRole('button', { name: '执行平差' }));
}

function switchToControlled() {
  fireEvent.click(screen.getByRole('radio', { name: '控制站平差' }));
}

function addStation(vertex: string, x: string, y: string) {
  fireEvent.click(screen.getByRole('button', { name: /添加控制站/ }));
  const rows = document.querySelectorAll('.station-row');
  const i = rows.length - 1;
  fireEvent.change(screen.getByLabelText(`控制站 ${i + 1} 站位`), {
    target: { value: vertex },
  });
  fireEvent.change(screen.getByLabelText(`控制站 ${i + 1} x 坐标`), {
    target: { value: x },
  });
  fireEvent.change(screen.getByLabelText(`控制站 ${i + 1} y 坐标`), {
    target: { value: y },
  });
}

function lockEdge(id: string) {
  fireEvent.click(screen.getByLabelText(`锁定边 ${id}`));
}

function applyControl() {
  fireEvent.click(screen.getByTestId('apply-control'));
}

/** 表格中某 id 行的全部单元格文本 */
function rowCells(id: string): string[] {
  const rows = [...document.querySelectorAll('tbody tr')];
  const row = rows.find(
    (r) => (r as HTMLTableRowElement).cells[1]?.textContent === id,
  ) as HTMLTableRowElement | undefined;
  if (!row) throw new Error(`未找到边 ${id} 的表格行`);
  return [...row.cells].map((c) => c.textContent ?? '');
}

async function downloadJsonAndCapture(): Promise<string> {
  capturedJson = null;
  fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
  await waitFor(() => expect(capturedJson).not.toBeNull());
  return capturedJson as unknown as string;
}

beforeEach(() => {
  capturedJson = null;
  drawnTexts.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    makeRecordingFake2d(),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    if (blob instanceof Blob && blob.type === 'application/json') {
      void blobToText(blob).then((t) => {
        capturedJson = t;
      });
    }
    return 'blob:mock-url';
  });
  setCanvasCssSize(640, 480);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCanvasCssSize(0, 0);
});

describe('控制站平差模式 — 编辑到导出全流程', () => {
  it('指定控制站与锁边 → 采纳 → 叠画/表格/JSON 同源一致', async () => {
    render(<App />);
    runAdjustment(input5);
    expect(screen.getByTestId('mode-indicator').textContent).toBe('常规平差');
    expect(screen.getByTestId('sum-adjusted-x').textContent).toBe('0');

    // 切换到控制站模式：空配置自动生效，整圈一个区段
    switchToControlled();
    expect(screen.getByTestId('mode-indicator').textContent).toBe('控制站平差');
    expect(screen.getByTestId('control-panel')).toBeTruthy();
    expect(screen.getByTestId('segment-0').textContent).toContain('所需修正 (0, 0)');
    expect(screen.queryByTestId('segment-1')).toBeNull();
    expect(screen.queryByTestId('control-stale')).toBeNull();

    // 编辑控制站 K1=v3 (501, 2) 并锁定 E2：未采纳前已采纳结果标记过期
    addStation('3', '501', '2');
    lockEdge('E2');
    expect(screen.getByTestId('control-stale').textContent).toContain('已过期');

    // 采纳：过期标记消失，区段明细与表格同步更新
    applyControl();
    expect(screen.queryByTestId('control-stale')).toBeNull();
    expect(screen.getByTestId('export-notice').textContent).toContain(
      '控制站平差完成',
    );
    expect(screen.getByTestId('segment-0').textContent).toContain('所需修正 (1, 2)');
    expect(screen.getByTestId('segment-1').textContent).toContain(
      '所需修正 (-1, -2)',
    );
    expect(screen.getByTestId('control-summary').textContent).toContain(
      'K1=v3 (501, 2)',
    );

    // 表格：锁边 E2 修正恒 0 且带状态标记；E1 按 UTF-8 决胜多得 +1；E3 终点是 K1
    expect(rowCells('E2')[5]).toBe('0');
    expect(rowCells('E2')[6]).toBe('0');
    expect(rowCells('E2')[9]).toContain('锁定');
    expect(rowCells('E1')[5]).toBe('+1');
    expect(rowCells('E1')[6]).toBe('+1');
    expect(rowCells('E3')[9]).toContain('终点=K1');
    expect(screen.getByTestId('sum-adjusted-x').textContent).toBe('0');
    expect(screen.getByTestId('sum-adjusted-y').textContent).toBe('0');

    // 叠画：画布签名与同一结果对象一致，控制站标注已上屏
    const expected = adjustTraverseControlled(edges5, {
      stations: [{ vertexIndex: 3, x: 501, y: 2 }],
      lockedEdgeIds: ['E2'],
    });
    if (!expected.ok) throw new Error('预期结果应可行');
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    expect(canvasResultSignature(canvas)).toBe(resultSignature(expected.result));
    expect(drawnTexts).toContain('K1=v3');

    // 导出 JSON：与表格/图形共用同一结果
    const json = await downloadJsonAndCapture();
    const parsed = JSON.parse(json) as {
      schema: string;
      controlStations: Array<{ vertexIndex: number; x: number; y: number }>;
      lockedEdgeIds: string[];
      segments: Array<{
        index: number;
        fromVertex: number;
        toVertex: number;
        requiredCorrection: { x: number; y: number };
        adjustableEdgeIds: string[];
        lockedEdgeIds: string[];
      }>;
      edges: Array<{ id: string; corrX: number; corrY: number; adjustedDx: number; adjustedDy: number }>;
    };
    expect(parsed.schema).toBe('traverse-adjustment/2');
    expect(parsed.controlStations).toEqual([{ vertexIndex: 3, x: 501, y: 2 }]);
    expect(parsed.lockedEdgeIds).toEqual(['E2']);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].fromVertex).toBe(0);
    expect(parsed.segments[0].toVertex).toBe(3);
    expect(parsed.segments[0].requiredCorrection).toEqual({ x: 1, y: 2 });
    expect(parsed.segments[0].adjustableEdgeIds).toEqual(['E1', 'E3']);
    expect(parsed.segments[0].lockedEdgeIds).toEqual(['E2']);
    expect(parsed.segments[1].requiredCorrection).toEqual({ x: -1, y: -2 });
    const byId = Object.fromEntries(parsed.edges.map((e) => [e.id, e]));
    expect(byId.E1.corrX).toBe(1);
    expect(byId.E2.corrX).toBe(0);
    expect(byId.E2.corrY).toBe(0);
    expect(byId.E5.corrX).toBe(-1);
    expect(byId.E5.corrY).toBe(-1);
    expect(parsed.edges.reduce((s, e) => s + e.adjustedDx, 0)).toBe(0);
    expect(parsed.edges.reduce((s, e) => s + e.adjustedDy, 0)).toBe(0);
  });

  it('非法控制站编辑不覆盖已采纳结果，但明确标记过期', async () => {
    render(<App />);
    runAdjustment(input5);
    switchToControlled();
    addStation('3', '501', '2');
    lockEdge('E2');
    applyControl();
    expect(screen.queryByTestId('control-stale')).toBeNull();
    expect(rowCells('E1')[5]).toBe('+1');

    // 非法编辑：x 改为非整数文本 → 校验错误 + 过期标记，采纳被禁用
    fireEvent.change(screen.getByLabelText('控制站 1 x 坐标'), {
      target: { value: 'abc' },
    });
    expect(screen.getByTestId('control-validation').textContent).toContain(
      '整数毫米',
    );
    expect(screen.getByTestId('control-stale').textContent).toContain('已过期');
    expect(
      screen.getByTestId('apply-control').hasAttribute('disabled'),
    ).toBe(true);

    // 已采纳结果未被覆盖：表格与导出仍是旧配置
    expect(rowCells('E1')[5]).toBe('+1');
    const json = await downloadJsonAndCapture();
    const parsed = JSON.parse(json) as {
      controlStations: Array<{ x: number }>;
    };
    expect(parsed.controlStations[0].x).toBe(501);

    // 改成合法但不同的坐标：仍标记过期，采纳后过期标记消失
    fireEvent.change(screen.getByLabelText('控制站 1 x 坐标'), {
      target: { value: '600' },
    });
    expect(screen.queryByTestId('control-validation')).toBeNull();
    expect(screen.getByTestId('control-stale').textContent).toContain('已过期');
    applyControl();
    expect(screen.queryByTestId('control-stale')).toBeNull();
    expect(screen.getByTestId('segment-0').textContent).toContain(
      '所需修正 (100, 2)',
    );
  });

  it('全锁区段不可行：定位区段报错，不发布部分新图', async () => {
    render(<App />);
    runAdjustment(input5);
    switchToControlled();
    // 空配置已采纳：整圈一个区段
    expect(screen.getByTestId('segment-0').textContent).toContain('所需修正 (0, 0)');

    // K1=v3 (500, 1) 且锁死段内全部边 E1/E2/E3 → 段 1 无可调边且位移不满足
    addStation('3', '500', '1');
    lockEdge('E1');
    lockEdge('E2');
    lockEdge('E3');
    applyControl();

    const alert = screen.getByTestId('control-error');
    expect(alert.textContent).toContain('区段 1');
    expect(alert.textContent).toContain('不可行');
    expect(alert.textContent).toContain('未发布任何新成果图');

    // 当前成果仍是采纳前的空配置结果：一个区段、合计为 0、导出无控制站
    expect(screen.queryByTestId('segment-1')).toBeNull();
    expect(screen.getByTestId('sum-adjusted-x').textContent).toBe('0');
    const json = await downloadJsonAndCapture();
    const parsed = JSON.parse(json) as {
      schema: string;
      controlStations: unknown[];
      segments: unknown[];
    };
    expect(parsed.schema).toBe('traverse-adjustment/2');
    expect(parsed.controlStations).toEqual([]);
    expect(parsed.segments).toHaveLength(1);
  });

  it('无控制站模式的导出契约保持不变（schema/1 且无控制站字段）', async () => {
    render(<App />);
    runAdjustment(input5);
    const json = await downloadJsonAndCapture();
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schema).toBe('traverse-adjustment/1');
    expect('controlStations' in parsed).toBe(false);
    expect('lockedEdgeIds' in parsed).toBe(false);
    expect('segments' in parsed).toBe(false);
    expect(screen.queryByTestId('control-panel')).toBeNull();
  });
});
