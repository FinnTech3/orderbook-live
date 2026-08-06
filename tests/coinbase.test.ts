import { describe, expect, it } from "vitest";
import {
  parseL2Update,
  parseSnapshot,
  parseWebsocketSnapshot,
} from "../src/lib/venues/coinbase.js";
import { Instrument } from "../src/lib/types.js";
import type { CoinbaseL2Message, CoinbaseSnapshotPayload } from "../src/lib/venues/coinbase.js";

const BTC = new Instrument("BTC-USD", "0.01", "0.00000001");

describe("parseSnapshot", () => {
  it("turns Coinbase's REST snapshot into a neutral Snapshot", () => {
    const payload: CoinbaseSnapshotPayload = {
      time: "2026-08-06T12:00:00Z",
      sequence: 123_456,
      bids: [
        ["64000.00", "0.5", "id-1"],
        ["63999.00", "1.0", "id-2"],
      ],
      asks: [
        ["64001.00", "0.25", "id-3"],
      ],
    };
    const snap = parseSnapshot(payload, BTC);
    expect(snap.sequence).toBe(123_456);
    expect(snap.eventTimeMs).toBe(Date.parse("2026-08-06T12:00:00Z"));
    expect(snap.bids).toEqual([
      { price: BTC.toTicks("64000.00"), size: BTC.toLots("0.5") },
      { price: BTC.toTicks("63999.00"), size: BTC.toLots("1.0") },
    ]);
    expect(snap.asks).toHaveLength(1);
  });

  it("accepts sequence as a string", () => {
    const snap = parseSnapshot(
      { sequence: "999", bids: [], asks: [] },
      BTC,
    );
    expect(snap.sequence).toBe(999);
  });

  it("filters out zero-size levels — snapshot rows can carry them", () => {
    const snap = parseSnapshot(
      {
        sequence: 1,
        bids: [
          ["64000.00", "1.0"],
          ["63999.00", "0"], // removed level with size 0
        ],
        asks: [],
      },
      BTC,
    );
    expect(snap.bids).toEqual([
      { price: BTC.toTicks("64000.00"), size: BTC.toLots("1.0") },
    ]);
  });

  it("rejects a bad sequence value", () => {
    expect(() =>
      parseSnapshot({ sequence: "not-a-number", bids: [], asks: [] }, BTC),
    ).toThrow();
    expect(() =>
      parseSnapshot({ sequence: -5, bids: [], asks: [] }, BTC),
    ).toThrow();
  });

  it("falls back to now() when no time is present", () => {
    const before = Date.now();
    const snap = parseSnapshot({ sequence: 1, bids: [], asks: [] }, BTC);
    const after = Date.now();
    expect(snap.eventTimeMs).toBeGreaterThanOrEqual(before);
    expect(snap.eventTimeMs).toBeLessThanOrEqual(after);
  });
});

describe("parseL2Update", () => {
  const baseMessage = (
    changes: ReadonlyArray<readonly [string, string, string]>,
    sequence: number | string = 500,
  ): CoinbaseL2Message => ({
    type: "l2update",
    product_id: "BTC-USD",
    time: "2026-08-06T12:00:05.123Z",
    sequence,
    changes,
  });

  it("splits buy/sell changes into bids/asks and preserves the sequence", () => {
    const msg = baseMessage([
      ["buy", "64000.00", "0.5"],
      ["sell", "64001.00", "0"],
    ]);
    const delta = parseL2Update(msg, BTC);
    expect(delta.sequence).toBe(500);
    expect(delta.previousSequence).toBeNull();
    expect(delta.bids).toEqual([
      { price: BTC.toTicks("64000.00"), size: BTC.toLots("0.5") },
    ]);
    expect(delta.asks).toEqual([
      { price: BTC.toTicks("64001.00"), size: 0 },
    ]);
    expect(delta.eventTimeMs).toBe(Date.parse("2026-08-06T12:00:05.123Z"));
  });

  it("snaps off-grid prices instead of rejecting them", () => {
    // Coinbase occasionally sends prices with more decimals than the tick.
    // The strict toTicks would throw; the parser uses snap.
    const msg = baseMessage([["buy", "64000.004", "0.5"]]);
    const delta = parseL2Update(msg, BTC);
    expect(delta.bids[0]!.price).toBe(BTC.toTicks("64000.00"));
  });

  it("throws when the sequence is missing", () => {
    const msg: CoinbaseL2Message = {
      type: "l2update",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:05Z",
      changes: [["buy", "64000.00", "1.0"]],
    };
    expect(() => parseL2Update(msg, BTC)).toThrow(/sequence/);
  });

  it("throws on an unknown side string", () => {
    const msg = baseMessage([["sideways", "64000.00", "1.0"] as [string, string, string]]);
    expect(() => parseL2Update(msg, BTC)).toThrow(/side/);
  });

  it("refuses to parse non-l2update messages", () => {
    const wrong: CoinbaseL2Message = {
      type: "snapshot",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:00Z",
      bids: [],
      asks: [],
    };
    expect(() => parseL2Update(wrong, BTC)).toThrow(/expected l2update/);
  });

  it("handles empty changes without breaking", () => {
    const delta = parseL2Update(baseMessage([]), BTC);
    expect(delta.bids).toEqual([]);
    expect(delta.asks).toEqual([]);
  });
});

describe("parseWebsocketSnapshot", () => {
  it("borrows the caller-supplied sequence", () => {
    const msg: CoinbaseL2Message = {
      type: "snapshot",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:00Z",
      bids: [["64000.00", "1.0"]],
      asks: [["64001.00", "0.5"]],
    };
    const snap = parseWebsocketSnapshot(msg, BTC, 42);
    expect(snap.sequence).toBe(42);
    expect(snap.bids).toHaveLength(1);
    expect(snap.asks).toHaveLength(1);
  });

  it("refuses to parse non-snapshot messages", () => {
    const wrong: CoinbaseL2Message = {
      type: "l2update",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:00Z",
      sequence: 1,
      changes: [],
    };
    expect(() => parseWebsocketSnapshot(wrong, BTC, 1)).toThrow(/expected snapshot/);
  });
});
