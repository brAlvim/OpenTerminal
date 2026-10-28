"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, fmt, fmtBig } from "../../lib/api";
import { useTerminal } from "../../store/terminal";

// /api/trader/scan (day-trader-skill's trader-scanner). Daily hits carry rsi and
// volume; opening-range-breakout hits carry the range and the bar that broke it.
type Hit = {
  symbol: string;
  setups: string[];
  price: number;
  rsi?: number | null;
  volume?: number | null;
  at?: string;
  or_high?: number;
  or_low?: number;
  pct_over?: number;
};
type Scan = { as_of?: string; scanned: number; failed: number; hits: Hit[]; note: string };

const SETUP_LABEL: Record<string, string> = {
  breakout_20d: "20D breakout",
  bull_flag: "Bull flag",
  reclaim_ma20: "Reclaim MA20",
  oversold: "Oversold",
  oversold_bounce: "Oversold bounce",
  orb: "ORB",
};

export default function ScannerWidget() {
  const watchlist = useTerminal((s) => s.watchlist);
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [mode, setMode] = useState<"daily" | "orb">("daily");
  const [custom, setCustom] = useState("");
  // Only what was submitted is scanned: a scan per keystroke would burn the
  // /api/trader rate limit and Yahoo's patience.
  const [applied, setApplied] = useState("");
  // An empty box scans the watchlist, so the widget is useful the moment it's added.
  const symbols = (applied.trim() ? applied.toUpperCase().split(/[\s,]+/) : watchlist).filter(Boolean).slice(0, 200);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["trader-scan", mode, symbols.join(",")],
    queryFn: () => apiGet<Scan>(`/api/trader/scan?mode=${mode}&symbols=${encodeURIComponent(symbols.join(","))}`),
    enabled: symbols.length > 0,
    staleTime: mode === "orb" ? 60_000 : 300_000,
    retry: false,
  });

  return (
    <div>
      <div className="flex gap-1 p-1 items-center flex-wrap border-b border-[var(--border)]">
        <button className={`term-btn ${mode === "daily" ? "active" : ""}`} onClick={() => setMode("daily")}>DAILY</button>
        <button className={`term-btn ${mode === "orb" ? "active" : ""}`} onClick={() => setMode("orb")}>ORB</button>
        <input
          className="flex-1 min-w-[120px]"
          placeholder={`Watchlist (${watchlist.length}) — or type tickers`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setApplied(custom)}
        />
        <button
          className="term-btn"
          onClick={() => (custom === applied ? refetch() : setApplied(custom))}
          disabled={isFetching}
        >
          {isFetching ? "SCANNING…" : "SCAN"}
        </button>
      </div>
      {error && <div className="p-2 down">{(error as Error).message}</div>}
      {data && (
        <>
          <table className="data-table">
            <thead>
              {mode === "daily" ? (
                <tr><th>Sym</th><th>Setups</th><th>Close</th><th>RSI</th><th>Vol</th></tr>
              ) : (
                <tr><th>Sym</th><th>Broke out</th><th>Price</th><th>Range</th><th>% over</th></tr>
              )}
            </thead>
            <tbody>
              {data.hits.map((h) => (
                <tr key={h.symbol} onClick={() => setActiveSymbol(h.symbol)}>
                  <td className="font-bold">{h.symbol}</td>
                  {mode === "daily" ? (
                    <>
                      <td className="amber">{h.setups.map((s) => SETUP_LABEL[s] ?? s).join(", ")}</td>
                      <td>{fmt(h.price)}</td>
                      <td className={h.rsi != null && h.rsi < 30 ? "down" : ""}>{fmt(h.rsi, 1)}</td>
                      <td className="dim">{fmtBig(h.volume)}</td>
                    </>
                  ) : (
                    <>
                      <td className="amber">{h.at}</td>
                      <td>{fmt(h.price)}</td>
                      <td className="dim">{fmt(h.or_low)}–{fmt(h.or_high)}</td>
                      <td className="up">{fmt(h.pct_over)}%</td>
                    </>
                  )}
                </tr>
              ))}
              {data.hits.length === 0 && (
                <tr><td colSpan={5} className="dim p-3">No setups in these {data.scanned} charts.</td></tr>
              )}
            </tbody>
          </table>
          <div className="dim text-[10px] p-1">
            {data.scanned} scanned{data.failed ? `, ${data.failed} failed` : ""}{data.as_of ? ` · as of ${data.as_of}` : ""}. {data.note}
          </div>
        </>
      )}
      {!data && !error && isFetching && <div className="p-2 dim">Scanning {symbols.length} charts…</div>}
    </div>
  );
}
