"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../../lib/api";
import { useTerminal } from "../../store/terminal";

// /api/trader/congress (day-trader-skill's trader-pelosi): House Periodic
// Transaction Reports, straight from the Clerk's index and PDFs.
type Filing = { doc_id: string; name: string; district: string; filed: string; year: number; url: string };
type PtrRow = {
  owner: string | null;
  asset: string;
  ticker: string | null;
  type_name: string | null;
  date: string | null;
  amount: string;
  days_to_disclose?: number;
  late?: boolean;
  option?: { contracts: number; kind: string; strike: number; expires: string };
};
type Report =
  | { available: false; url: string }
  | { available: true; url: string; report: { rows: PtrRow[] } };

const OWNER: Record<string, string> = { SP: "Spouse", JT: "Joint", DC: "Child" };

function ReportRows({ filing }: { filing: Filing }) {
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const { data, isLoading, error } = useQuery({
    queryKey: ["ptr", filing.year, filing.doc_id],
    queryFn: () => apiGet<Report>(`/api/trader/congress/${filing.year}/${filing.doc_id}`),
    staleTime: Infinity,
    retry: false,
  });
  if (error) return <div className="p-2 down">{(error as Error).message}</div>;
  if (isLoading || !data) return <div className="p-2 dim">Reading the PTR…</div>;
  if (!data.available) {
    return (
      <div className="p-2 dim">
        Reading PTRs here needs poppler&apos;s <span className="amber">pdftotext</span> on the server
        (<span className="amber">brew install poppler</span>).{" "}
        <a className="amber hover:underline" href={data.url} target="_blank" rel="noopener noreferrer">Open the PDF</a>.
      </div>
    );
  }
  return (
    <table className="data-table">
      <thead><tr><th>Traded</th><th>Asset</th><th>Type</th><th>Amount</th><th>Owner</th><th>Days</th></tr></thead>
      <tbody>
        {data.report.rows.map((r, i) => (
          <tr key={i} onClick={() => r.ticker && setActiveSymbol(r.ticker)}>
            <td className="dim">{r.date ?? "—"}</td>
            <td className="!text-left truncate max-w-[180px]" title={r.asset}>
              {r.ticker && <span className="font-bold">{r.ticker} </span>}
              <span className="dim">{r.asset}</span>
              {r.option && <span className="amber"> {r.option.contracts} {r.option.kind} {r.option.strike} {r.option.expires}</span>}
            </td>
            <td className={/purchase/i.test(r.type_name ?? "") ? "up" : /sale/i.test(r.type_name ?? "") ? "down" : ""}>{r.type_name}</td>
            <td>{r.amount}</td>
            <td className="dim">{(r.owner && OWNER[r.owner]) ?? "Member"}</td>
            <td className={r.late ? "down" : "dim"}>{r.days_to_disclose ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CongressWidget() {
  const [member, setMember] = useState("");
  const [applied, setApplied] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ["congress", applied],
    queryFn: () => apiGet<Filing[]>(`/api/trader/congress${applied ? `?member=${encodeURIComponent(applied)}` : ""}`),
    staleTime: 3_600_000,
    retry: false,
  });

  return (
    <div>
      <form
        className="flex gap-1 p-1 border-b border-[var(--border)]"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(member.trim());
          setOpen(null);
        }}
      >
        <input className="flex-1" placeholder="Member (e.g. pelosi) — empty for everyone" value={member} onChange={(e) => setMember(e.target.value)} />
        <button className="term-btn" type="submit">FILTER</button>
      </form>
      {error && <div className="p-2 down">{(error as Error).message}</div>}
      {isLoading && <div className="p-2 dim">Loading the House Clerk&apos;s index…</div>}
      <table className="data-table">
        <thead><tr><th>Filed</th><th>Member</th><th>District</th><th></th></tr></thead>
        <tbody>
          {data.map((f) => (
            <FilingRow key={f.doc_id} f={f} open={open === f.doc_id} toggle={() => setOpen(open === f.doc_id ? null : f.doc_id)} />
          ))}
          {!isLoading && !error && data.length === 0 && (
            <tr><td colSpan={4} className="dim p-3">No periodic transaction reports{applied ? ` for “${applied}”` : ""} this year.</td></tr>
          )}
        </tbody>
      </table>
      <div className="dim text-[10px] p-1">
        Public filings, read quickly — not early: reports are due up to 45 days after the trade. Amounts are ranges.
      </div>
    </div>
  );
}

function FilingRow({ f, open, toggle }: { f: Filing; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr onClick={toggle}>
        <td className="dim">{f.filed}</td>
        <td className="!text-left">{f.name.replace(/^Hon\.\s*/, "")}</td>
        <td className="dim">{f.district}</td>
        <td>
          <a className="amber hover:underline" href={f.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            PDF
          </a>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="!p-0 !whitespace-normal bg-[var(--panel-2)]"><ReportRows filing={f} /></td>
        </tr>
      )}
    </>
  );
}
