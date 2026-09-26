import {
  isControlledResult,
  type AnyAdjustmentResult,
} from '../core/types';

interface ResultTableProps {
  result: AnyAdjustmentResult;
}

function fmt(v: bigint | number): string {
  const s = typeof v === 'bigint' ? v.toString() : String(v);
  // 千分位分组，保留前导负号（BigInt.toLocaleString 的 signDisplay 类型在 ES2020 lib 下不可用）
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

function signed(v: bigint): string {
  const n = Number(v);
  if (n > 0) return `+${n}`;
  return String(n);
}

export function ResultTable({ result }: ResultTableProps) {
  const sumCorrX = result.edges.reduce((s, e) => s + e.corrX, 0n);
  const sumCorrY = result.edges.reduce((s, e) => s + e.corrY, 0n);
  const sumAdjX = result.edges.reduce(
    (s, e) => s + BigInt(e.dx) + e.corrX,
    0n,
  );
  const sumAdjY = result.edges.reduce(
    (s, e) => s + BigInt(e.dy) + e.corrY,
    0n,
  );

  // 控制站模式：锁边与“边的终点是控制站”的状态标记
  const controlled = isControlledResult(result);
  const lockedIds = new Set(controlled ? result.lockedEdgeIds : []);
  const stationAtVertex = new Map<number, number>();
  if (controlled) {
    result.controlStations.forEach((s, i) => {
      stationAtVertex.set(s.vertexIndex, i + 1);
    });
  }

  return (
    <div className="table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            <th>#</th>
            <th>id</th>
            <th>dx</th>
            <th>dy</th>
            <th>weight</th>
            <th>Δx 修正</th>
            <th>Δy 修正</th>
            <th>平差后 dx</th>
            <th>平差后 dy</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {result.edges.map((e, i) => {
            const marks: string[] = [];
            if (lockedIds.has(e.id)) marks.push('锁定');
            const k = stationAtVertex.get(i + 1);
            if (k !== undefined) marks.push(`终点=K${k}`);
            return (
              <tr key={e.id}>
                <td className="num dim">{i + 1}</td>
                <td className="mono">{e.id}</td>
                <td className="num">{fmt(e.dx)}</td>
                <td className="num">{fmt(e.dy)}</td>
                <td className="num">{fmt(e.weight)}</td>
                <td className={`num corr ${e.corrX > 0n ? 'pos' : e.corrX < 0n ? 'neg' : ''}`}>
                  {signed(e.corrX)}
                </td>
                <td className={`num corr ${e.corrY > 0n ? 'pos' : e.corrY < 0n ? 'neg' : ''}`}>
                  {signed(e.corrY)}
                </td>
                <td className="num strong">
                  {fmt(BigInt(e.dx) + e.corrX)}
                </td>
                <td className="num strong">
                  {fmt(BigInt(e.dy) + e.corrY)}
                </td>
                <td className="dim">{marks.join('，')}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} className="dim">
              合计（修正量须抵消闭合差）
            </td>
            <td className={`num ${sumCorrX !== 0n ? 'pos' : ''}`}>{signed(sumCorrX)}</td>
            <td className={`num ${sumCorrY !== 0n ? 'pos' : ''}`}>{signed(sumCorrY)}</td>
            <td className="num strong zero-check" data-testid="sum-adjusted-x">
              {sumAdjX.toString()}
            </td>
            <td className="num strong zero-check" data-testid="sum-adjusted-y">
              {sumAdjY.toString()}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
