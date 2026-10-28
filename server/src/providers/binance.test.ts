import { afterEach, describe, expect, it, vi } from "vitest";
import { history, orderBook, quote, resetGeoBlock } from "./binance.js";

function mockFetchOnce(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("binance provider URL encoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes query-string-breaking characters in orderBook's symbol", async () => {
    const fetchMock = mockFetchOnce({ bids: [], asks: [] });
    await orderBook("AAA&limit=5000");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("&limit=5000USDT");
    expect(url).toContain("symbol=" + encodeURIComponent("AAA&limit=5000".toUpperCase() + "USDT"));
    // exactly one `&` (the intended separator before &limit=20) survives unescaped
    expect(url.split("&").length).toBe(2);
  });

  it("encodes the symbol in quote()", async () => {
    const fetchMock = mockFetchOnce({
      lastPrice: "1", priceChange: "0", priceChangePercent: "0", openPrice: "1",
      highPrice: "1", lowPrice: "1", prevClosePrice: "1", bidPrice: "1", askPrice: "1", volume: "1",
    });
    await quote("AAA#bogus");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("AAA#bogus".toUpperCase() + "USDT"));
    expect(url).not.toContain("#bogus");
  });

  it("encodes the symbol in history()", async () => {
    const fetchMock = mockFetchOnce([]);
    await history("AAA&x=1", "6M");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("AAA&x=1".toUpperCase() + "USDT"));
    expect(url.split("&").length).toBe(3); // symbol, interval, limit only
  });
});

describe("binance geo-block fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGeoBlock();
  });

  const ticker = {
    lastPrice: "1", priceChange: "0", priceChangePercent: "0", openPrice: "1",
    highPrice: "1", lowPrice: "1", prevClosePrice: "1", bidPrice: "1", askPrice: "1", volume: "1",
  };

  it("retries on Binance.US when api.binance.com answers 451, and labels the quote", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 451, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ticker });
    vi.stubGlobal("fetch", fetchMock);

    const q = await quote("BTC");

    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/api\.binance\.com\//);
    expect(fetchMock.mock.calls[1][0]).toMatch(/^https:\/\/api\.binance\.us\/api\/v3\/ticker\/24hr\?symbol=BTCUSDT$/);
    expect(q.exchange).toBe("Binance.US");
  });

  it("remembers the block and goes straight to Binance.US on the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await history("BTC", "6M");
    await history("ETH", "6M");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toMatch(/^https:\/\/api\.binance\.us\/.*ETHUSDT/);
  });

  it("does not fall back on an ordinary error like a bad symbol", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(orderBook("NOPE")).rejects.toThrow("binance 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
