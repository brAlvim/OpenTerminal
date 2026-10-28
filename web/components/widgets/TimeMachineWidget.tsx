"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost, fmt, type Quote } from "../../lib/api";
import { useTerminal, useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

// Shapes returned by /api/trader/timemachine and /api/trader/size (day-trader-skill's
// trader-timemachine, trader-budget and trader-risk), trimmed to what is shown here.
type TimeMachine = {
  mc: {
    replays: number; seed: number; until: string; pool_sessions: number;
    p_target: number; p_stop: number; p_neither: number; p_green: number;
    median_close: number; p5_close: number; p95_close: number; avg_R: number;
    bands: number[][]; band_times: string[];
  };
  history: { sessions: number; triggered: number; target: number; stop: number; close: number; avg_R: number };
  verdict: string;
  verdict_notes: string[];
  warnings: string[];
  note: string;
};

type Sizing = {
  sizing: {
    qty: number; bound_by: string; cost: number; max_loss: number; reward_risk: number;
    risk_per_share: number; refusal: string | null;
    limits: Array<{ name: string; shares: number; how: string; binds: boolean }>;
  };
  risk: { results: Array<{ verdict: "PASS" | "BLOCK"; reasons: string[]; warnings: string[]; info: string[] }> } | null;
};

type Plan = { entry: string; stop: string; target: string; entryTime: string; date: string; until: string };

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Starting plan from the last price: stop 1% below, target at 2R. */
function defaultPlan(price: number | null): Plan {
  if (!price) return { entry: "", stop: "", target: "", entryTime: "10:15", date: "", until: "" };
  const stop = price * 0.99;
  return {
    entry: price.toFixed(2),
    stop: stop.toFixed(2),
    target: (price + 2 * (price - stop)).toFixed(2),
    entryTime: "10:15",
    date: "",
    until: "",
  };
}

/** 5-95% and 25-75% bands of the replays, the median path, and the entry/stop/target lines. */
function FanChart({ tm, entry, stop, target }: { tm: TimeMachine; entry: number; stop: number; target: number }) {
  // PAD leaves room for the level labels drawn above the top and bottom lines.
  const W = 300, H = 110, PAD = 10;
  const bands = tm.mc.bands;
  const lo = Math.min(stop, ...bands.map((b) => b[0]));
  const hi = Math.max(target, ...bands.map((b) => b[4]));
  const x = (i: number) => PAD + (i / Math.max(1, bands.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + ((hi - v) / (hi - lo || 1)) * (H - 2 * PAD);
  const area = (a: number, b: number) =>
    bands.map((p, i) => `${x(i)},${y(p[b])}`).join(" ") + " " +
    bands.map((p, i) => `${x(i)},${y(p[a])}`).reverse().join(" ");
  const level = (v: number, color: string, label: string) => (
    <g>
      <line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)} stroke={color} strokeDasharray="3 3" strokeWidth={0.8} />
      <text x={W - PAD - 2} y={y(v) - 2} fill={color} fontSize={7} textAnchor="end">{label} {fmt(v)}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }} preserveAspectRatio="none">
      <polygon points={area(0, 4)} fill="var(--amber)" opacity={0.12} />
      <polygon points={area(1, 3)} fill="var(--amber)" opacity={0.22} />
      <polyline points={bands.map((p, i) => `${x(i)},${y(p[2])}`).join(" ")} fill="none" stroke="var(--amber)" strokeWidth={1} />
      {level(target, "var(--up)", "TGT")}
      {level(entry, "var(--text-dim)", "ENTRY")}
      {level(stop, "var(--down)", "STOP")}
      <text x={PAD} y={H - 1} fill="var(--text-dim)" fontSize={7}>{tm.mc.band_times[0]}</text>
      <text x={W - PAD} y={H - 1} fill="var(--text-dim)" fontSize={7} textAnchor="end">{tm.mc.band_times[tm.mc.band_times.length - 1]}</text>
    </svg>
  );
}

function OddsBar({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 whitespace-nowrap dim">{label}</span>
      <div className="flex-1 h-2 bg-[var(--panel-2)]">
        <div className="h-2" style={{ width: pct(value), background: `var(--${cls})` }} />
      </div>
      <span className={`w-14 text-right ${cls === "text-dim" ? "dim" : cls}`}>{pct(value)}</span>
    </div>
  );
}

function RulesEditor() {
  const rules = useTerminal((s) => s.traderRules);
  const setRules = useTerminal((s) => s.setTraderRules);
  const field = (key: keyof typeof rules, label: string) => (
    <label className="flex items-center gap-1">
      <span className="dim">{label}</span>
      <input
        className="w-20"
        type="number"
        value={rules[key]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (v > 0) setRules({ ...rules, [key]: v });
        }}
      />
    </label>
  );
  return (
    <div className="flex gap-3 flex-wrap px-1 pb-1">
      {field("budget", "Budget $")}
      {field("max_loss_per_trade_usd", "Max loss/trade $")}
      {field("max_daily_loss_usd", "Max loss/day $")}
    </div>
  );
}

export default function TimeMachineWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const rules = useTerminal((s) => s.traderRules);
  const [plan, setPlan] = useState<Plan>(defaultPlan(null));
  const [showRules, setShowRules] = useState(false);

  const { data: quote } = useQuery({
    queryKey: ["quote-once", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`))[0] ?? null,
    staleTime: 60_000,
  });

  // A new symbol starts a new plan from its own price.
  useEffect(() => {
    setPlan(defaultPlan(quote?.price ?? null));
  }, [symbol, quote?.price === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const nums = { entry: Number(plan.entry), stop: Number(plan.stop), target: Number(plan.target) };

  const tm = useMutation({
    mutationFn: () =>
      apiPost<TimeMachine>("/api/trader/timemachine", {
        symbol,
        ...nums,
        entryTime: plan.entryTime,
        ...(plan.date ? { date: plan.date } : {}),
        ...(plan.until ? { until: plan.until } : {}),
      }),
  });

  const size = useMutation({
    mutationFn: () => apiPost<Sizing>("/api/trader/size", { symbol, ...nums, ...rules }),
  });

  const input = (key: keyof Plan, label: string, cls = "w-20", placeholder = "") => (
    <label className="flex flex-col">
      <span className="dim text-[10px] uppercase">{label}</span>
      <input
        className={cls}
        value={plan[key]}
        placeholder={placeholder}
        onChange={(e) => setPlan({ ...plan, [key]: e.target.value })}
      />
    </label>
  );

  const risk = size.data?.risk?.results[0];

  return (
    <div className="p-1 space-y-2">
      <div className="flex gap-2 flex-wrap items-end">
        {input("entry", "Entry")}
        {input("stop", "Stop")}
        {input("target", "Target")}
        {input("entryTime", "Bar close", "w-16", "10:15")}
        {input("date", "Date", "w-24", "today")}
        {input("until", "Flat by", "w-16", "16:00")}
      </div>
      <div className="flex gap-1 items-center">
        <button className="term-btn" onClick={() => tm.mutate()} disabled={tm.isPending}>
          {tm.isPending ? "REPLAYING…" : "RUN TIME MACHINE"}
        </button>
        <button className="term-btn" onClick={() => size.mutate()} disabled={size.isPending}>
          {size.isPending ? "SIZING…" : "SIZE & RISK"}
        </button>
        <button className={`term-btn ${showRules ? "active" : ""}`} onClick={() => setShowRules(!showRules)}>
          RULES
        </button>
        <span className="ml-auto dim">long only · 5-min bars</span>
      </div>
      {showRules && <RulesEditor />}

      {tm.error && <div className="down">{(tm.error as Error).message}</div>}
      {tm.data && (
        <div className="space-y-1 border-t border-[var(--border)] pt-1">
          <FanChart tm={tm.data} {...nums} />
          <OddsBar label="Target 1st" value={tm.data.mc.p_target} cls="up" />
          <OddsBar label="Stop 1st" value={tm.data.mc.p_stop} cls="down" />
          <OddsBar label="Neither" value={tm.data.mc.p_neither} cls="text-dim" />
          <div>
            <span className="dim">At {tm.data.mc.until}:</span> median {fmt(tm.data.mc.median_close)}
            <span className="dim">, 90% between</span> {fmt(tm.data.mc.p5_close)}–{fmt(tm.data.mc.p95_close)}
            <span className="dim">. Avg R</span>{" "}
            <span className={tm.data.mc.avg_R >= 0 ? "up" : "down"}>{tm.data.mc.avg_R.toFixed(3)}</span>
          </div>
          <div className="dim">
            History: the same rule fired {tm.data.history.triggered} of {tm.data.history.sessions} sessions —{" "}
            {tm.data.history.target} target, {tm.data.history.stop} stop, {tm.data.history.close} neither. Avg R{" "}
            {tm.data.history.avg_R.toFixed(3)}.
          </div>
          <div className="amber">{tm.data.verdict}</div>
          {tm.data.verdict_notes.map((n) => <div key={n} className="dim">{n}</div>)}
          {tm.data.warnings.map((w) => <div key={w} className="down">⚠ {w}</div>)}
          <div className="dim text-[10px]">
            {tm.data.mc.replays.toLocaleString()} replays, seed {tm.data.mc.seed}, pool of {tm.data.mc.pool_sessions} sessions. {tm.data.note}
          </div>
        </div>
      )}

      {size.error && <div className="down">{(size.error as Error).message}</div>}
      {size.data && (
        <div className="space-y-1 border-t border-[var(--border)] pt-1">
          {size.data.sizing.refusal ? (
            <div className="down">No order: {size.data.sizing.refusal}</div>
          ) : (
            <div>
              <span className="amber font-bold">{size.data.sizing.qty} shares</span>{" "}
              <span className="dim">= ${fmt(size.data.sizing.cost)}, max loss at the stop</span>{" "}
              <span className="down">${fmt(size.data.sizing.max_loss)}</span>{" "}
              <span className="dim">· R:R {size.data.sizing.reward_risk.toFixed(2)} · bound by {size.data.sizing.bound_by}</span>
            </div>
          )}
          <table className="data-table">
            <thead><tr><th>Limit</th><th>Shares</th><th>How</th></tr></thead>
            <tbody>
              {size.data.sizing.limits.map((l) => (
                <tr key={l.name} className={l.binds ? "amber" : ""}>
                  <td>{l.name}</td>
                  <td>{l.shares}</td>
                  <td className="dim">{l.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {risk && (
            <div>
              <span className={risk.verdict === "PASS" ? "up font-bold" : "down font-bold"}>RISK {risk.verdict}</span>
              {[...risk.reasons, ...risk.warnings].map((r) => <div key={r} className="dim">· {r}</div>)}
            </div>
          )}
          <div className="dim text-[10px]">
            A stop is an order, not a promise: in a fast market it can fill below the stop. Analysis only — OpenTerminal never places orders.
          </div>
        </div>
      )}
    </div>
  );
}
