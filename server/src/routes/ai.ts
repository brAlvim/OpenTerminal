import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as trader from "./trader.js";

export const aiRouter = Router();

// Uses ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
// If no credentials are configured, the endpoint reports the assistant as unavailable.
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM = `You are the AI assistant inside OpenTerminal, a Bloomberg-style financial terminal.
You help the user interpret market data, charts, news, options chains and macro indicators.
Answer concisely and professionally, in the language the user writes in.
When market data is provided in the conversation as JSON context, ground your answer in it.
You are not a licensed financial advisor: never give personalized investment advice or tell the user what to buy or sell.

You have analysis tools from the day-trader-skill pack. Use them when the user asks about a trade plan, odds, position size, setups, earnings or Congress trades. They only read public data and do arithmetic: nothing here can place an order, so never offer to.
- run_time_machine replays a plan (entry, stop, target) 10,000 times from the stock's own last 60 days of 5-minute bars. Report the odds, the verdict line exactly as the tool printed it, and the seed. Say once that it is a simulation, not a prediction.
- size_position sizes a plan from the stop and checks it against the day's risk rules. A stop is an order, not a promise: it can fill worse in a fast market.
- If a tool refuses, tell the user its reason in one line instead of guessing numbers.`;

// Each tool is a thin wrapper over the same functions /api/trader serves, so the
// assistant and the widgets always agree. Inputs are validated there with zod.
const TOOLS: Anthropic.Tool[] = [
  {
    name: "run_time_machine",
    description:
      "Monte Carlo replay of an intraday long trade plan: 10,000 simulated rests-of-session built from the symbol's own 5-minute bars (last ~60 days), plus the same rule re-run on every past session. Returns odds of target first / stop first / neither, the close distribution, average R and a verdict. The entry bar must already have closed on `date`.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "US ticker, e.g. AAPL" },
        entry: { type: "number" },
        stop: { type: "number", description: "Below the entry (long only)" },
        target: { type: "number", description: "Above the entry" },
        entryTime: { type: "string", description: "New York close time of the entry bar on the 5-minute grid, 24h, e.g. 10:15" },
        date: { type: "string", description: "Session date YYYY-MM-DD; default today in New York" },
        until: { type: "string", description: "Optional flat-by time, e.g. 15:55" },
      },
      required: ["symbol", "entry", "stop", "target", "entryTime"],
    },
  },
  {
    name: "size_position",
    description:
      "Sizes a long trade plan in whole shares from the distance to the stop and the user's budget rules, then checks the order against daily risk limits (max loss, trades per day, trading window). Returns the binding limit, share count, cost, max loss and a PASS/BLOCK verdict with reasons.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        entry: { type: "number" },
        stop: { type: "number" },
        target: { type: "number" },
        budget: { type: "number", description: "Money set aside for trading, default 5000" },
        max_loss_per_trade_usd: { type: "number", description: "Default 50" },
      },
      required: ["symbol", "entry", "stop", "target"],
    },
  },
  {
    name: "scan_setups",
    description:
      "Scans a list of tickers for chart setups. mode=daily (daily closes: 20-day closing breakout, bull flag, reclaim of the 20-day average, RSI oversold/bounce) or mode=orb (opening-range breakouts so far today, after 9:50 AM New York).",
    input_schema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Up to 200 tickers" },
        mode: { type: "string", enum: ["daily", "orb"] },
      },
      required: ["symbols"],
    },
  },
  {
    name: "earnings_summary",
    description:
      "Quarter-by-quarter revenue, margins, net income and diluted EPS from the company's own SEC XBRL filings, the plain-language changes vs a year earlier, and links to the latest 10-Q/10-K and earnings 8-K.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "congress_trades",
    description:
      "Recent Periodic Transaction Reports (stock trades) filed by members of the US House, from the House Clerk's index: member, district, filing date and the PDF link. Filings lag the trades by up to 45 days.",
    input_schema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Last name or 'First Last', e.g. pelosi" },
        since: { type: "string", description: "Only filings on or after YYYY-MM-DD" },
      },
    },
  },
];

async function runTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "run_time_machine": {
      // The fan-chart bands, histogram and per-session trades are for drawing;
      // the model only needs the numbers it will quote.
      const r = await trader.timeMachine(input);
      const { bands, band_times, hist, ...mc } = r.mc;
      return { plan: r.plan, mc, history: r.history, verdict: r.verdict, verdict_notes: r.verdict_notes, warnings: r.warnings, note: r.note };
    }
    case "size_position":
      return trader.sizePosition(input);
    case "scan_setups":
      return trader.scanSetups(input);
    case "earnings_summary":
      return trader.earnings(input?.symbol);
    case "congress_trades":
      return (await trader.congressFilings(input ?? {})).slice(0, 30);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// A plan, a size and a scan is three rounds; anything past this is a loop.
const MAX_TOOL_ROUNDS = 6;

aiRouter.post("/chat", async (req, res) => {
  const { messages, context } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  try {
    const contextBlock = context
      ? [{ role: "user" as const, content: `Current terminal context (JSON):\n${JSON.stringify(context)}` }]
      : [];
    const convo: Anthropic.MessageParam[] = [...contextBlock, ...messages];
    let response: Anthropic.Message | undefined;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      response = await getClient().messages.create({
        model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        tools: TOOLS,
        messages: convo,
      });
      if (response.stop_reason !== "tool_use" || round === MAX_TOOL_ROUNDS) break;

      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      convo.push({ role: "assistant", content: response.content });
      // All results go back in one user message, failures included, so the
      // model sees every call it made and can explain a refusal.
      const results = await Promise.all(
        calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
          try {
            return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(await runTool(call.name, call.input)) };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { type: "tool_result", tool_use_id: call.id, content: msg, is_error: true };
          }
        })
      );
      convo.push({ role: "user", content: results });
    }
    if (!response || response.stop_reason === "refusal") {
      return res.json({ text: "The assistant declined to answer this request." });
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("");
    if (!text && response.stop_reason === "tool_use") {
      return res.json({ text: "The assistant stopped after too many tool calls. Try a narrower question." });
    }
    res.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("api_key") || msg.includes("authentication")) {
      return res.status(503).json({ error: "AI assistant unavailable: set ANTHROPIC_API_KEY on the server." });
    }
    res.status(502).json({ error: msg });
  }
});
