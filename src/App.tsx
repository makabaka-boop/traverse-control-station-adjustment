import { useCallback, useMemo, useRef, useState } from 'react';
import {
  canvasMatchesResult,
  TraverseChart,
} from './components/TraverseChart';
import { ResultTable } from './components/ResultTable';
import { ControlEditor } from './components/ControlEditor';
import { adjustTraverse } from './core/adjustment';
import { adjustWithControls } from './core/controlAdjustment';
import {
  emptyControlDraft,
  validateControlDraft,
  type ControlDraft,
} from './core/controlOptions';
import { parseTraverseInput } from './core/parse';
import type { AdjustmentResult, RawEdge } from './core/types';
import { SAMPLE_JSON } from './core/sample';
import {
  downloadCanvasPng,
  downloadResultJson,
  isCanvasDrawable,
  shareOrDownloadCanvas,
} from './utils/export';

export function App() {
  const [inputText, setInputText] = useState('');
  // lastValid 保留上次有效图形：非法输入只更新错误提示，不触碰它
  const [result, setResult] = useState<AdjustmentResult | null>(null);
  const [rawEdges, setRawEdges] = useState<RawEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<'info' | 'error'>('info');
  // 当前平差结果的位图是否已实际绘制（隐藏/零尺寸时为 false）
  const [chartReady, setChartReady] = useState(false);
  const [exporting, setExporting] = useState(false);
  const canvasHostRef = useRef<HTMLDivElement>(null);

  // —— 控制站平差模式状态 ——
  const [controlDraft, setControlDraft] = useState<ControlDraft>(emptyControlDraft());
  // 已采纳控制参数的指纹；null 表示当前结果为普通平差（无控制结果）
  const [adoptedKey, setAdoptedKey] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [infeasible, setInfeasible] = useState<{
    segmentIndex: number;
    message: string;
  } | null>(null);

  const handleChartReadyChange = useCallback((ready: boolean) => {
    setChartReady(ready);
  }, []);

  const showNotice = (text: string, kind: 'info' | 'error' = 'info') => {
    setNotice(text);
    setNoticeKind(kind);
  };

  const closureInfo = useMemo(() => {
    if (!result) return null;
    const closed = result.closureX === 0n && result.closureY === 0n;
    return {
      closed,
      mode: result.mode === 'control' ? ('control' as const) : ('plain' as const),
      fx: result.closureX.toString(),
      fy: result.closureY.toString(),
      w: result.totalWeight.toString(),
      count: result.edges.length,
      stationCount: result.controls?.length ?? 0,
      lockedCount: result.lockedEdgeIds?.length ?? 0,
    };
  }, [result]);

  // 草稿实时校验（不触碰已采纳结果）；非法时给出明确错误并标记过期
  const draftValidation = useMemo(() => {
    if (rawEdges.length === 0) return null;
    return validateControlDraft(controlDraft, rawEdges);
  }, [controlDraft, rawEdges]);

  const isControlAdopted = result?.mode === 'control';

  // 过期判定：没有结果、草稿非法、或草稿指纹与已采纳结果不一致
  const controlStale = useMemo(() => {
    if (rawEdges.length === 0 || !result) return false;
    if (!draftValidation || !draftValidation.ok) return true;
    if (isControlAdopted) return draftValidation.key !== adoptedKey;
    // 当前为普通平差：任何非空控制配置都算未采纳的过期编辑
    const d = draftValidation.options;
    return d.stations.length > 0 || d.lockedEdgeIds.length > 0;
  }, [
    rawEdges.length,
    result,
    draftValidation,
    isControlAdopted,
    adoptedKey,
  ]);

  // 更换边数据：控制站配置全部失效，回到普通平差（站位下标/锁边 id 需重新指定）
  const applyEdges = (edges: RawEdge[]) => {
    const adjusted = adjustTraverse(edges);
    setRawEdges(edges);
    setResult(adjusted);
    setError(null);
    setControlDraft(emptyControlDraft());
    setAdoptedKey(null);
    setControlError(null);
    setInfeasible(null);
    setNotice(`平差完成：${edges.length} 条边，两轴修正后整数和严格为 0`);
  };

  const handleRun = () => {
    const parsed = parseTraverseInput(inputText);
    if (!parsed.ok) {
      // 拒绝整份数据，保留上次有效图形
      setError(parsed.error);
      return;
    }
    applyEdges(parsed.edges);
  };

  const handleLoadSample = () => {
    setInputText(SAMPLE_JSON);
    const parsed = parseTraverseInput(SAMPLE_JSON);
    if (parsed.ok) applyEdges(parsed.edges);
  };

  const handleClear = () => {
    setInputText('');
    setResult(null);
    setRawEdges([]);
    setError(null);
    setNotice(null);
    setChartReady(false);
    setControlDraft(emptyControlDraft());
    setAdoptedKey(null);
    setControlError(null);
    setInfeasible(null);
  };

  // 采纳控制配置并平差：非法或不可行均不覆盖已采纳结果，只明确标记
  const handleApplyControl = () => {
    const parsed = validateControlDraft(controlDraft, rawEdges);
    if (!parsed.ok) {
      setControlError(parsed.error);
      setInfeasible(null);
      return;
    }
    const outcome = adjustWithControls(rawEdges, parsed.options);
    if (!outcome.feasible) {
      setControlError(null);
      setInfeasible({ segmentIndex: outcome.segmentIndex, message: outcome.message });
      return;
    }
    setResult(outcome.result);
    setAdoptedKey(parsed.key);
    setControlError(null);
    setInfeasible(null);
    setError(null);
    const { stations, lockedEdgeIds } = parsed.options;
    setNotice(
      `控制站平差完成：${stations.length} 个控制站、${lockedEdgeIds.length} 条锁边、` +
        `${outcome.result.segments?.length ?? 0} 个区段，控制站与最终终点均精确到位`,
    );
  };

  // 恢复普通平差：丢弃控制编辑，按当前边重新整网平差
  const handleRevertControl = () => {
    setResult(adjustTraverse(rawEdges));
    setControlDraft(emptyControlDraft());
    setAdoptedKey(null);
    setControlError(null);
    setInfeasible(null);
    setNotice('已恢复普通整网平差');
  };

  const handleDraftChange = (next: ControlDraft) => {
    setControlDraft(next);
    // 编辑即清除“不可行”结论与编辑错误提示（下次采纳时重新判定）
    setControlError(null);
    setInfeasible(null);
  };

  const getCanvas = (): HTMLCanvasElement | null =>
    canvasHostRef.current?.querySelector('canvas') ?? null;

  /**
   * 取“可交付的当前图形画布”：必须存在、尺寸非零且位图签名与当前平差一致。
   * 隐藏期间残留的旧画布或空画布一律拒绝，避免把过期/缺失图形当成成果。
   */
  const getExportableCanvas = (): HTMLCanvasElement | null => {
    if (!result || !chartReady) return null;
    const canvas = getCanvas();
    if (!canvas || !isCanvasDrawable(canvas)) return null;
    return canvasMatchesResult(canvas, result) ? canvas : null;
  };

  const handleDownloadJson = () => {
    if (!result) return;
    downloadResultJson(result);
    showNotice('已下载 JSON 结果（BigInt 精度的精确整数）');
  };

  const handleDownloadPng = async () => {
    const canvas = getExportableCanvas();
    if (!canvas) {
      showNotice('当前图形尚未绘制完成，无法下载 PNG', 'error');
      return;
    }
    setExporting(true);
    try {
      const ok = await downloadCanvasPng(canvas);
      if (ok) showNotice('已下载当前平差图形 PNG');
      else showNotice('PNG 编码为空，下载未完成（未生成任何文件）', 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleShare = async () => {
    const canvas = getExportableCanvas();
    if (!canvas) {
      showNotice('当前图形尚未绘制完成，无法共享或下载 PNG', 'error');
      return;
    }
    setExporting(true);
    try {
      const mode = await shareOrDownloadCanvas(canvas);
      if (mode === 'shared') showNotice('已通过系统分享面板共享当前平差图形');
      else if (mode === 'downloaded')
        showNotice('当前环境不支持分享，已下载当前平差图形 PNG');
      else if (mode === 'cancelled')
        showNotice('已取消分享，未共享也未下载任何文件');
      else showNotice('画布导出失败，未生成任何文件', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>闭合导线平差工作台</h1>
        <p className="subtitle">
          离线纯前端 · 按权重最大余数分配 · 东西/南北独立闭合 · 整数毫米精度（BigInt）
        </p>
      </header>

      <main className="layout">
        <section className="panel input-panel">
          <h2>输入顺序边（JSON 数组）</h2>
          <p className="hint">
            每条边仅含 <code>id</code>（唯一 ASCII）、
            <code>dx</code>/<code>dy</code>（|分量| ≤ 10⁶ 的整数）、
            <code>weight</code>（正整数），3–200 条。
            非法字段或重复 id 将拒绝整份数据并保留上次有效图形。
          </p>
          <textarea
            className="json-input"
            aria-label="顺序边 JSON 输入"
            spellCheck={false}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={'[\n  {"id":"E1","dx":10,"dy":5,"weight":2},\n  ...\n]'}
          />
          <div className="button-row">
            <button className="primary" onClick={handleRun} disabled={!inputText.trim()}>
              执行平差
            </button>
            <button onClick={handleLoadSample}>载入示例</button>
            <button onClick={handleClear} disabled={!result && !inputText}>
              清空
            </button>
          </div>

          {error && (
            <div className="banner error" role="alert">
              <strong>已拒绝整份数据：</strong>
              {error}
              {result && <span className="banner-note">（画面仍为上次有效图形）</span>}
            </div>
          )}
          {!error && notice && (
            <div
              className={`banner ${noticeKind === 'error' ? 'error' : 'info'}`}
              role="status"
              data-testid="export-notice"
            >
              {notice}
            </div>
          )}

          {closureInfo && (
            <dl className="summary">
              <div>
                <dt>边数</dt>
                <dd data-testid="edge-count">{closureInfo.count}</dd>
              </div>
              <div>
                <dt>东西闭合差 fx</dt>
                <dd className={closureInfo.fx === '0' ? 'zero-check' : 'neg'}>
                  {closureInfo.fx}
                </dd>
              </div>
              <div>
                <dt>南北闭合差 fy</dt>
                <dd className={closureInfo.fy === '0' ? 'zero-check' : 'neg'}>
                  {closureInfo.fy}
                </dd>
              </div>
              <div>
                <dt>权重和 W</dt>
                <dd>{closureInfo.w}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd className={closureInfo.closed ? 'zero-check' : 'ok'}>
                  {closureInfo.mode === 'control'
                    ? `控制平差·${closureInfo.stationCount} 站 ${closureInfo.lockedCount} 锁`
                    : closureInfo.closed
                      ? '原本闭合'
                      : '已严格闭合'}
                </dd>
              </div>
            </dl>
          )}

          {result && rawEdges.length > 0 && (
            <ControlEditor
              draft={controlDraft}
              edges={rawEdges}
              validationError={controlError}
              stale={controlStale}
              infeasible={infeasible}
              onDraftChange={handleDraftChange}
              onApply={handleApplyControl}
              onRevert={handleRevertControl}
              adopted={isControlAdopted}
            />
          )}

          <h2 className="algo-title">算法口径（可逐毫米复算）</h2>
          <ol className="algo">
            <li>
              各轴独立处理，待分配总额 <code>T = −f</code>（f 为该轴闭合差，可为负）。
            </li>
            <li>
              欧几里得整除取<strong>下整商</strong>{' '}
              <code>q = floor(T·w / W)</code>，余数{' '}
              <code>r = T·w − q·W ∈ [0, W)</code>；负数下 floor 与向零截断不同。
            </li>
            <li>
              先各分 q，剩余 <code>R = T − Σq</code> 个单位（0 ≤ R &lt; n）给余数较大者。
            </li>
            <li>余数相同按 id 的 UTF-8 字节序（小者优先）。</li>
            <li>修正量总和恒等于 −f，修正后两轴整数和严格为 0。</li>
          </ol>
        </section>

        <section className="panel chart-panel">
          <div className="chart-toolbar">
            <h2>导线叠画</h2>
            <div className="button-row">
              <button
                onClick={handleShare}
                disabled={!result || !chartReady || exporting}
              >
                共享画布
              </button>
              <button
                onClick={handleDownloadPng}
                disabled={!result || !chartReady || exporting}
              >
                下载 PNG
              </button>
              <button className="primary" onClick={handleDownloadJson} disabled={!result}>
                下载 JSON
              </button>
            </div>
          </div>
          <div className="chart-host" ref={canvasHostRef}>
            <TraverseChart result={result} onReadyChange={handleChartReadyChange} />
          </div>
          {result && (
            <p
              className={`chart-state ${chartReady ? 'ready' : 'pending'}`}
              role="status"
              data-testid="chart-state"
            >
              {chartReady
                ? '当前平差图形已绘制，可共享或下载 PNG'
                : '当前平差图形尚未绘制（区域隐藏或尺寸为零），PNG 导出暂不可用'}
            </p>
          )}
          {result && (
            <p className="hint chart-meta">
              原始边数 {rawEdges.length}；灰虚线为原始路线（红色为未闭合缺口），蓝实线为
              {result.mode === 'control' ? '经控制站平差后路线，橙色方块为固定控制站' : '平差后路线'}
              。
            </p>
          )}
        </section>
      </main>

      {result && (
        <section className="panel table-panel">
          <h2>逐边修正量（整数毫米）</h2>
          <ResultTable result={result} />
        </section>
      )}

      <footer className="app-footer">
        全部计算在浏览器本地完成，无网络请求；数据不离开本机。
      </footer>
    </div>
  );
}
