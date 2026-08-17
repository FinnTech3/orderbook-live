import { describe, expect, it } from "vitest";
import { Instrument, OffGridError, Side, opposite } from "../src/lib/types.js";

describe("Instrument", () => {
  const btc = new Instrument("BTC-USD", "0.01", "0.00000001");

  it("converts a decimal price to integer ticks exactly", () => {
    expect(btc.toTicks("64653.20")).toBe(6_465_320);
    expect(btc.toTicks("100.00")).toBe(10_000);
    expect(btc.toTicks("0.01")).toBe(1);
  });

  it("round-trips a price without drift", () => {
    for (const s of ["64653.20", "0.01", "100.00", "1234.56"]) {
      const t = btc.toTicks(s);
      expect(btc.fromTicks(t).toFixed(btc.priceScale)).toBe(s);
    }
  });

  it("does not accept a value off the tick grid", () => {
    // 64653.205 is not a multiple of 0.01
    expect(() => btc.toTicks("64653.205")).toThrow(OffGridError);
  });

  it("accepts inputs with fewer decimals than the grid", () => {
    // sizeScale is 8 for BTC but "0.5" only has 1 decimal. The parser must
    // upscale rather than error, venues routinely trim trailing zeros.
    expect(btc.toLots("0.5")).toBe(50_000_000);
    expect(btc.toLots("1")).toBe(100_000_000);
    expect(btc.toTicks("100")).toBe(10_000);
  });

  it("snapTicks rounds to nearest, used at the venue boundary", () => {
    // The strict version rejects; snap version accepts and rounds.
    expect(btc.snapTicks("64653.204")).toBe(btc.toTicks("64653.20"));
    expect(btc.snapTicks("64653.205")).toBe(btc.toTicks("64653.20") + 1);
  });

  it("survives the 0.1 + 0.2 problem in floats", () => {
    const grid = new Instrument("T", "0.1", "1");
    // In IEEE-754, 0.1 + 0.2 !== 0.3. On the tick grid they agree.
    expect(grid.toTicks("0.1") + grid.toTicks("0.2")).toBe(grid.toTicks("0.3"));
  });

  it("rejects a nonsense grid at construction", () => {
    expect(() => new Instrument("T", "0", "1")).toThrow();
    expect(() => new Instrument("T", "1", "-1")).toThrow();
  });

  it("rejects a non-decimal string", () => {
    expect(() => btc.toTicks("abc")).toThrow();
    expect(() => btc.toTicks("1e5")).toThrow();
  });
});

describe("Side", () => {
  it("opposites are involutive", () => {
    expect(opposite(Side.Bid)).toBe(Side.Ask);
    expect(opposite(Side.Ask)).toBe(Side.Bid);
    expect(opposite(opposite(Side.Bid))).toBe(Side.Bid);
  });
});
