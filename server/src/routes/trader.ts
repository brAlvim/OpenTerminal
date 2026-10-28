import { Router } from "express";
import { z } from "zod";
import { cached } from "../cache.js";
import { UA as SEC_USER_AGENT } from "../providers/secedgar.js";
import { SkillRefusal, SkillUnavailable, hasPdftotext, inWorkdir, runSkill } from "../providers/traderskill.js";

// Analysis tools from day-trader-skill (server/vendor/day-trader-skill). Every
// one of them only reads public data and does arithmetic: the pack's order
// executor (trader-broker) is not vendored, and nothing here places an order.
export const traderRouter = Router();

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,5}([.-][A-Z])?$/, "a US ticker like AAPL or BRK.B");
const price = z.number().finite().positive().max(1_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-19");
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, "a New York time like 10:15 or 15:55");

/** Today's date in New York, the clock every tool in the pack runs on. */
function newYorkToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

// ---- Time Machine: 10,000 replays of the rest of the session + the same rule on every past session

export const timeMachineInput = z.object({
  symbol,
  entry: price,
  stop: price,
  target: price,
  /** Close of the entry bar, on the 5-minute grid (e.g. "10:15"). */
  entryTime: clock,
  /** The plan's session; the tool's default is today in New York. */
  date: isoDate.optional(),
  /** End each replay at this time instead of the close (a flat-by time). */
  until: clock.optional(),
});

export async function timeMachine(input: z.infer<typeof timeMachineInput>) {
  const p = timeMachineInput.parse(input);
  const args = ["run", "--json", "--symbol", p.symbol, "--entry", String(p.entry), "--stop", String(p.stop),
    "--target", String(p.target), "--entry-time", p.entryTime];
  if (p.date) args.push("--date", p.date);
  if (p.until) args.push("--until", p.until);
  // Seeded (19), so the same plan on the same data gives the same numbers:
  // caching for a few minutes changes nothing but the load on Yahoo.
  return cached(`tm:${args.join(" ")}`, 300_000, () => runSkill<TimeMachineResult>("timemachine.py", args));
}

export type TimeMachineResult = {
  plan: Record<string, unknown>;
  mc: {
    replays: number; seed: number; bars_left: number; until: string;
    p_target: number; p_stop: number; p_neither: number; p_green: number;
    median_close: number; p5_close: number; p95_close: number; avg_R: number; r_at_target: number;
    pool_sessions: number; pool_from: string; pool_to: string;
    bands: number[][]; band_times: string[];
    hist: { lo: number; hi: number; bins: number[] };
  };
  history: { sessions: number; triggered: number; target: number; stop: number; close: number; avg_R: number };
  verdict: string;
  verdict_notes: string[];
  warnings: string[];
  note: string;
};

// ---- Budget + Risk: size the trade from the stop, then check it against the day's rules

export const sizeInput = z.object({
  symbol,
  entry: price,
  stop: price,
  target: price,
  /** A limit order at the entry instead of a market order. */
  limit: z.boolean().optional(),
  // The user's own rules (trader-budget's config.json); unset ones keep the pack's defaults.
  budget: price.optional(),
  max_loss_per_trade_usd: price.optional(),
  max_daily_loss_usd: price.optional(),
  max_position_pct: z.number().positive().max(100).optional(),
  cash_buffer_pct: z.number().min(0).max(100).optional(),
  min_reward_risk: z.number().positive().max(20).optional(),
});

// trader-budget/config.example.json, minus the broker fields nothing here uses.
const DEFAULT_RULES = {
  budget: 5000,
  cash_buffer_pct: 10,
  max_position_pct: 75,
  max_order_usd: 4000,
  min_order_usd: 5,
  max_loss_per_trade_usd: 50,
  max_daily_loss_usd: 150,
  max_trades_per_day: 3,
  max_orders_per_day: 10,
  min_reward_risk: 1.0,
  require_stop: true,
  no_entries_before: "09:45",
  no_entries_after: "15:30",
  flat_by: "15:55",
  fractional: false,
  paper: true,
  blocked: [],
  allow_options: false,
  allow_margin: false,
  allow_short: false,
  pdt_guard: false,
};

export async function sizePosition(input: z.infer<typeof sizeInput>) {
  const { symbol: sym, entry, stop, target, limit, ...rules } = sizeInput.parse(input);
  const config = { ...DEFAULT_RULES, ...rules };
  const plan = { symbol: sym, side: "buy", date: newYorkToday(), setup: "level", entry, stop, target, flat_by: config.flat_by };
  return inWorkdir({ "config.json": config, "plan.json": plan }, async (run) => {
    const budget = await run<{ sizing: { refusal: string | null } & Record<string, unknown>; orders: unknown[] }>(
      "size.py",
      ["--write", "--json", ...(limit ? ["--limit"] : [])],
      // Exit 1 with JSON = a sizing refusal (R:R too low, zero shares...), shown to the user.
      { okCodes: [1] }
    );
    // A refused size writes no order, so there is nothing for trader-risk to check.
    const risk = budget.sizing.refusal ? null : await run<Record<string, unknown>>("check.py", ["--json"], { okCodes: [1] });
    return { sizing: budget.sizing, risk };
  });
}

// ---- Scanner: setups on daily closes (before the open) or opening-range breakouts (during the session)

export const scanInput = z.object({
  symbols: z.array(symbol).min(1).max(200),
  mode: z.enum(["daily", "orb"]).default("daily"),
});

export async function scanSetups(input: z.input<typeof scanInput>) {
  const { symbols, mode } = scanInput.parse(input);
  const list = [...new Set(symbols)].sort().join(",");
  // Exit 1 = "nothing matched" and still prints the JSON; a scan that could not
  // run at all (before 9:50 AM for orb, a holiday) prints one plain line instead.
  return cached(`scan:${mode}:${list}`, mode === "orb" ? 60_000 : 300_000, () =>
    runSkill<Record<string, unknown>>("scan.py", [mode, "--symbols", list, "--no-write", "--show", "200", "--json"], {
      okCodes: [1],
      timeoutMs: 120_000,
    })
  );
}

// ---- Earnings analyst: the numbers each company actually filed with the SEC, quarter by quarter

export async function earnings(sym: string) {
  const s = symbol.parse(sym);
  return cached(`facts:${s}`, 6 * 3_600_000, async () => {
    const out = await runSkill<Array<{ ticker: string; result?: unknown; error?: string } & Record<string, unknown>>>(
      "facts.py",
      [s, "--quarters", "6", "--user-agent", SEC_USER_AGENT, "--json"]
    );
    if (!out[0] || out[0].error) throw new SkillRefusal(out[0]?.error ?? `no SEC filings found for ${s}`);
    return out[0];
  });
}

// ---- Congress: House periodic transaction reports, straight from the Clerk's index and PDFs

export const congressInput = z.object({
  member: z.string().trim().max(64).regex(/^[\p{L} .,'-]+$/u, "a member's name").optional(),
  since: isoDate.optional(),
});

export async function congressFilings(input: z.infer<typeof congressInput>) {
  const p = congressInput.parse(input);
  const args = ["index", "--limit", "100", "--json"];
  if (p.member) args.push("--member", p.member);
  if (p.since) args.push("--since", p.since);
  // The Clerk rebuilds the index about once a day.
  return cached(`ptr:${args.join(" ")}`, 3_600_000, () =>
    runSkill<CongressFiling[]>("ptr.py", args, { okCodes: [1] })
  );
}

export type CongressFiling = { doc_id: string; name: string; district: string; filed: string; year: number; url: string };

export async function congressReport(docId: string, year: number) {
  const id = z.string().regex(/^\d{5,10}$/).parse(docId);
  const y = z.number().int().min(2008).max(2100).parse(year);
  const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${y}/${id}.pdf`;
  // Without poppler the tool can only save the PDF, so send the reader to it.
  if (!(await hasPdftotext())) return { available: false as const, url };
  const report = await cached(`ptr-doc:${y}:${id}`, 24 * 3_600_000, () =>
    runSkill<Record<string, unknown>>("ptr.py", ["fetch", id, "--year", String(y), "--json"], { okCodes: [1] })
  );
  return { available: true as const, url, report };
}

// ---- HTTP

function fail(req: { path: string }, res: any, err: unknown) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });
  if (err instanceof SkillUnavailable) return res.status(503).json({ error: err.message });
  if (err instanceof SkillRefusal) return res.status(422).json({ error: err.message });
  console.error("[trader]", req.path, err instanceof Error ? err.message : String(err));
  res.status(502).json({ error: "The trader tool failed. Try again shortly." });
}

traderRouter.post("/timemachine", async (req, res) => {
  try {
    res.json(await timeMachine(req.body ?? {}));
  } catch (err) {
    fail(req, res, err);
  }
});

traderRouter.post("/size", async (req, res) => {
  try {
    res.json(await sizePosition(req.body ?? {}));
  } catch (err) {
    fail(req, res, err);
  }
});

traderRouter.get("/scan", async (req, res) => {
  try {
    const symbols = String(req.query.symbols ?? "").split(",").filter(Boolean);
    res.json(await scanSetups({ symbols, mode: req.query.mode === "orb" ? "orb" : "daily" }));
  } catch (err) {
    fail(req, res, err);
  }
});

traderRouter.get("/earnings/:symbol", async (req, res) => {
  try {
    res.json(await earnings(req.params.symbol));
  } catch (err) {
    fail(req, res, err);
  }
});

traderRouter.get("/congress", async (req, res) => {
  try {
    const member = typeof req.query.member === "string" && req.query.member ? req.query.member : undefined;
    const since = typeof req.query.since === "string" && req.query.since ? req.query.since : undefined;
    res.json(await congressFilings({ member, since }));
  } catch (err) {
    fail(req, res, err);
  }
});

traderRouter.get("/congress/:year/:docId", async (req, res) => {
  try {
    res.json(await congressReport(req.params.docId, Number(req.params.year)));
  } catch (err) {
    fail(req, res, err);
  }
});
