"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, fmtBig, pctClass } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

// /api/trader/earnings/:symbol (day-trader-skill's trader-analyst): the numbers the
// company actually filed with the SEC (XBRL), newest quarter first.
type Row = {
  end: string;
  fiscal: string;
  derived: boolean;
  revenue: number | null;
  net_income: number | null;
  eps_diluted: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  revenue_yoy: number | null;
  eps_yoy: number | null;
};
type Filing = { form: string; filed: string; url: string; exhibit?: string };
type Earnings = {
  result: { entity: string; rows: Row[]; ttm: { revenue: number | null; net_income: number | null; eps_diluted: number | null } };
  filings?: { report?: Filing; earnings_8k?: Filing };
  changes: string[];
  note: string | null;
};

const signed = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${fmt(n, 1)}%`);

export default function EarningsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const { data, isLoading, error } = useQuery({
    queryKey: ["trader-earnings", symbol],
    queryFn: () => apiGet<Earnings>(`/api/trader/earnings/${encodeURIComponent(symbol)}`),
    staleTime: 6 * 3_600_000,
    retry: false,
  });

  if (error) return <div className="p-2 down">{(error as Error).message}</div>;
  if (isLoading || !data) return <div className="p-2 dim">Reading {symbol}&apos;s SEC filings…</div>;

  const { result, filings } = data;
  return (
    <div>
      <div className="p-1 flex gap-3 flex-wrap border-b border-[var(--border)]">
        <span className="font-bold">{result.entity}</span>
        <span>
          <span className="dim">TTM rev</span> {fmtBig(result.ttm.revenue)} <span className="dim">· NI</span>{" "}
          {fmtBig(result.ttm.net_income)} <span className="dim">· EPS</span> {fmt(result.ttm.eps_diluted)}
        </span>
      </div>
      <div className="p-1 space-y-0.5">
        {data.changes.map((c) => <div key={c}>· {c}</div>)}
        {data.note && <div className="amber">{data.note}</div>}
      </div>
      <table className="data-table">
        <thead>
          <tr><th>Quarter</th><th>Revenue</th><th>YoY</th><th>Gross %</th><th>Op %</th><th>Net inc</th><th>EPS</th><th>YoY</th></tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.end} title={r.derived ? "Derived: the 10-K year minus the three quarters inside it" : `Period ended ${r.end}`}>
              <td>{r.fiscal}{r.derived && <span className="dim">*</span>}</td>
              <td>{fmtBig(r.revenue)}</td>
              <td className={pctClass(r.revenue_yoy)}>{signed(r.revenue_yoy)}</td>
              <td>{fmt(r.gross_margin, 1)}</td>
              <td>{fmt(r.operating_margin, 1)}</td>
              <td>{fmtBig(r.net_income)}</td>
              <td>{fmt(r.eps_diluted)}</td>
              <td className={pctClass(r.eps_yoy)}>{signed(r.eps_yoy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-1 flex gap-3 flex-wrap text-[11px]">
        {filings?.report && (
          <a className="amber hover:underline" href={filings.report.url} target="_blank" rel="noopener noreferrer">
            {filings.report.form} · {filings.report.filed}
          </a>
        )}
        {filings?.earnings_8k && (
          <a
            className="amber hover:underline"
            href={filings.earnings_8k.exhibit ?? filings.earnings_8k.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Earnings release (8-K) · {filings.earnings_8k.filed}
          </a>
        )}
        <span className="dim">* derived quarter · source: SEC XBRL</span>
      </div>
    </div>
  );
}
