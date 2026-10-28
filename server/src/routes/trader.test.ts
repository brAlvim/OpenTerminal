import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { traderRouter, sizePosition } from "./trader.js";
import { SkillRefusal, runSkill } from "../providers/traderskill.js";

// These run the vendored Python for real: size.py and check.py are pure
// arithmetic over the files they're given, so no network is involved.

function fakeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function getHandler(method: "get" | "post", path: string) {
  const layer = (traderRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} route registered for ${path}`);
  return layer.route.stack[0].handle as (req: Request, res: Response, next: () => void) => unknown;
}

const scratchDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith("openterminal-trader-")).length;

describe("sizePosition", () => {
  it("sizes from the stop, applies the user's rules, and runs the risk check on the result", async () => {
    const before = scratchDirs();
    const out = (await sizePosition({
      symbol: "aapl",
      entry: 100,
      stop: 98,
      target: 104,
      budget: 100_000,
      max_loss_per_trade_usd: 50,
    })) as any;

    // $50 max loss / $2 risk a share = 25 shares; the bigger budget leaves max loss as the binding limit.
    expect(out.sizing.qty).toBe(25);
    expect(out.sizing.bound_by).toBe("max loss");
    expect(out.sizing.max_loss).toBe(50);
    expect(out.risk.results).toHaveLength(1);
    expect(["PASS", "BLOCK"]).toContain(out.risk.results[0].verdict);
    // Each run's trader/ folder is removed afterwards.
    expect(scratchDirs()).toBe(before);
  });

  it("returns the refusal and skips the risk check when no order can be sized", async () => {
    // Reward:risk 0.25 is under the default min_reward_risk of 1.0.
    const out = (await sizePosition({ symbol: "AAPL", entry: 100, stop: 98, target: 100.5 })) as any;
    expect(out.sizing.refusal).toBeTruthy();
    expect(out.risk).toBeNull();
  });
});

describe("runSkill", () => {
  it("turns a tool's one-line refusal into a SkillRefusal", async () => {
    // No trader/plan.json in a fresh folder: size.py says so and exits non-zero.
    await expect(runSkill("size.py", ["--json"])).rejects.toBeInstanceOf(SkillRefusal);
  });
});

describe("POST /timemachine", () => {
  it("rejects a symbol that isn't a ticker with 400, before running anything", async () => {
    const handler = getHandler("post", "/timemachine");
    const req = {
      path: "/timemachine",
      body: { symbol: "AAPL;rm -rf", entry: 10, stop: 9, target: 12, entryTime: "10:15" },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as any).mock.calls[0][0].error).toMatch(/symbol/);
  });

  it("rejects an entry time that isn't a clock with 400", async () => {
    const handler = getHandler("post", "/timemachine");
    const req = {
      path: "/timemachine",
      body: { symbol: "AAPL", entry: 10, stop: 9, target: 12, entryTime: "--seed" },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("GET /congress/:year/:docId", () => {
  it("rejects a document id that isn't numeric with 400", async () => {
    const handler = getHandler("get", "/congress/:year/:docId");
    const req = { path: "/congress", params: { year: "2026", docId: "../../etc" } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
