import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/lib/book.js";
import {
  ExplicitPredecessorRule,
  InferredContinuityRule,
  Synchroniser,
  SyncState,
} from "../src/lib/sequencing.js";
import type { Gap, SequenceRule } from "../src/lib/sequencing.js";
import { Instrument, Side } from "../src/lib/types.js";
import type { DepthDelta, PriceSize, Snapshot } from "../src/lib/types.js";

const INSTRUMENT = new Instrument("TEST", "1", "1");

function sync(
  rule?: SequenceRule,
  options?: { maxBuffer?: number; onGap?: (gap: Gap) => void },
): Synchroniser {
  return new Synchroniser(new OrderBook(INSTRUMENT), rule, options);
}

function delta(
  sequence: number,
  bids: PriceSize[] = [],
  asks: PriceSize[] = [],
  previousSequence: number | null = sequence - 1,
): DepthDelta {
  return { sequence, previousSequence, eventTimeMs: sequence * 10, bids, asks };
}

function snapshot(sequence: number, bids: PriceSize[] = [{ price: 99, size: 5 }], asks: PriceSize[] = [{ price: 101, size: 5 }]): Snapshot {
  return { sequence, eventTimeMs: 1_000, bids, asks };
}

describe("Synchroniser — happy path", () => {
  it("starts disconnected and needs a snapshot", () => {
    const s = sync();
    expect(s.syncState).toBe(SyncState.Disconnected);
    expect(s.needsSnapshot).toBe(true);
  });

  it("deltas before the snapshot are buffered, not applied", () => {
    const s = sync();
    expect(s.onDelta(delta(101))).toBe(false);
    expect(s.syncState).toBe(SyncState.Buffering);
    expect(s.bufferedCount).toBe(1);
  });

  it("snapshot drains the buffer in order, discarding stale entries", () => {
    const s = sync();
    s.onDelta(delta(99, [{ price: 98, size: 1 }]));  // stale, superseded
    s.onDelta(delta(101, [{ price: 97, size: 7 }])); // bridges
    s.onDelta(delta(102, [{ price: 96, size: 3 }])); // follows

    expect(s.onSnapshot(snapshot(100))).toBe(true);
    expect(s.syncState).toBe(SyncState.Synced);
    expect(s.lastApplied).toBe(102);
    expect(s.book.sizeAt(Side.Bid, 97)).toBe(7);
    expect(s.book.sizeAt(Side.Bid, 96)).toBe(3);
    expect(s.book.sizeAt(Side.Bid, 98)).toBe(0);
    expect(s.stats.deltasDiscardedStale).toBe(1);
    expect(s.stats.deltasApplied).toBe(2);
  });

  it("deltas apply directly once synced", () => {
    const s = sync();
    s.onSnapshot(snapshot(100));
    expect(s.onDelta(delta(101, [{ price: 98, size: 4 }]))).toBe(true);
    expect(s.lastApplied).toBe(101);
  });

  it("empty buffer plus snapshot syncs immediately", () => {
    const s = sync();
    expect(s.onSnapshot(snapshot(100))).toBe(true);
    expect(s.needsSnapshot).toBe(false);
  });
});

describe("Synchroniser — gaps and resync", () => {
  it("a gap triggers resync and clears the book", () => {
    const seen: Gap[] = [];
    const s = sync(new InferredContinuityRule(), { onGap: (gap) => seen.push(gap) });
    s.onSnapshot(snapshot(100));
    s.onDelta(delta(101));
    expect(s.syncState).toBe(SyncState.Synced);

    // 103 does not follow 101 — sequence 102 was lost.
    expect(s.onDelta(delta(103))).toBe(false);
    expect(s.syncState).toBe(SyncState.Buffering);
    expect(s.book.bestBid()).toBeNull();
    expect(s.stats.gapsDetected).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.expectedAfter).toBe(101);
    expect(seen[0]!.gotSequence).toBe(103);
  });

  it("the delta that exposed the gap is kept for after resync", () => {
    const s = sync();
    s.onSnapshot(snapshot(100));
    s.onDelta(delta(103, [{ price: 97, size: 2 }])); // gap
    expect(s.bufferedCount).toBe(1);

    // Fresh snapshot at 102 lets the held delta apply.
    expect(s.onSnapshot(snapshot(102))).toBe(true);
    expect(s.book.sizeAt(Side.Bid, 97)).toBe(2);
    expect(s.lastApplied).toBe(103);
  });

  it("recovers fully after a gap", () => {
    const s = sync();
    s.onSnapshot(snapshot(100));
    s.onDelta(delta(105));  // gap
    s.onSnapshot(snapshot(104));
    expect(s.syncState).toBe(SyncState.Synced);
    expect(s.onDelta(delta(106, [{ price: 98, size: 9 }]))).toBe(true);
    expect(s.book.sizeAt(Side.Bid, 98)).toBe(9);
  });
});

describe("Synchroniser — snapshots that cannot be used", () => {
  it("a snapshot landing in a hole is rejected", () => {
    const s = sync();
    s.onDelta(delta(110));
    expect(s.onSnapshot(snapshot(100))).toBe(false);
    expect(s.syncState).toBe(SyncState.Buffering);
    expect(s.needsSnapshot).toBe(true);
    expect(s.stats.snapshotsRejected).toBe(1);
    expect(s.book.bestBid()).toBeNull();
  });

  it("a newer snapshot resolves the rejection", () => {
    const s = sync();
    s.onDelta(delta(110, [{ price: 97, size: 4 }]));
    s.onSnapshot(snapshot(100));
    expect(s.onSnapshot(snapshot(109))).toBe(true);
    expect(s.book.sizeAt(Side.Bid, 97)).toBe(4);
  });

  it("a snapshot while already synced is a no-op", () => {
    const s = sync();
    s.onSnapshot(snapshot(100));
    const before = s.stats.snapshotsApplied;
    expect(s.onSnapshot(snapshot(200))).toBe(true);
    expect(s.stats.snapshotsApplied).toBe(before);
    expect(s.lastApplied).toBe(100);
  });
});

describe("Synchroniser — buffer bounds and reordering", () => {
  it("buffer is bounded and drops the oldest", () => {
    const s = sync(new InferredContinuityRule(), { maxBuffer: 3 });
    for (let i = 101; i <= 110; i++) s.onDelta(delta(i));
    expect(s.bufferedCount).toBe(3);
    expect(s.stats.deltasDroppedOverflow).toBe(7);
  });

  it("zero buffer is rejected", () => {
    expect(() => sync(new InferredContinuityRule(), { maxBuffer: 0 })).toThrow();
  });

  it("out-of-order arrivals are counted and repaired", () => {
    const s = sync();
    // Two single-sequence messages received in reverse order. The
    // synchroniser sorts them before draining the buffer.
    s.onDelta(delta(102, [{ price: 96, size: 2 }], [], null));
    s.onDelta(delta(101, [{ price: 97, size: 1 }], [], null));
    expect(s.onSnapshot(snapshot(100))).toBe(true);
    expect(s.stats.outOfOrderArrivals).toBe(1);
    expect(s.lastApplied).toBe(102);
    expect(s.book.sizeAt(Side.Bid, 97)).toBe(1);
    expect(s.book.sizeAt(Side.Bid, 96)).toBe(2);
  });
});

describe("Synchroniser — duplicates and stale", () => {
  it("a duplicate delta is discarded without a resync", () => {
    const s = sync();
    s.onSnapshot(snapshot(100));
    s.onDelta(delta(101, [{ price: 98, size: 4 }]));
    expect(s.onDelta(delta(101, [{ price: 98, size: 4 }]))).toBe(false);
    expect(s.syncState).toBe(SyncState.Synced);
    expect(s.stats.gapsDetected).toBe(0);
    expect(s.stats.deltasDiscardedDuplicate).toBe(1);
    expect(s.book.sizeAt(Side.Bid, 98)).toBe(4);
    // Stream continues normally.
    expect(s.onDelta(delta(102, [{ price: 97, size: 1 }]))).toBe(true);
  });

  it("a wholly older delta is discarded, not treated as a gap", () => {
    // Also covers the ranged-sequence case: a delta whose whole range
    // sits below the last applied sequence.
    const s = sync();
    s.onSnapshot(snapshot(100));
    // A batched delta covering 101..110.
    s.onDelta(delta(110, [], [], 100));
    // A batched delta covering 102..104, wholly inside what was applied.
    expect(s.onDelta(delta(104, [], [], 101))).toBe(false);
    expect(s.stats.gapsDetected).toBe(0);
    expect(s.stats.deltasDiscardedDuplicate).toBe(1);
  });
});

describe("Synchroniser — venue rules", () => {
  it("ExplicitPredecessorRule follows the named predecessor", () => {
    const s = sync(new ExplicitPredecessorRule());
    s.onSnapshot(snapshot(100));
    expect(s.onDelta(delta(105, [], [], 100))).toBe(true);
    expect(s.onDelta(delta(110, [], [], 105))).toBe(true);
    expect(s.lastApplied).toBe(110);
  });

  it("ExplicitPredecessorRule catches a gap that adjacency would miss", () => {
    const s = sync(new ExplicitPredecessorRule());
    s.onSnapshot(snapshot(100));
    s.onDelta(delta(105, [], [], 100));
    // IDs are adjacent but the named predecessor is wrong.
    expect(s.onDelta(delta(110, [], [], 99))).toBe(false);
    expect(s.stats.gapsDetected).toBe(1);

    // Contrast: the adjacency rule (with the same sequences and null prev)
    // accepts these because 106..110 comes after 101..105.
    const adjacent = sync(new InferredContinuityRule());
    adjacent.onSnapshot(snapshot(100));
    adjacent.onDelta(delta(105, [], [], 100));
    expect(adjacent.onDelta(delta(110, [], [], 105))).toBe(true);
  });

  it("ExplicitPredecessorRule complains when the field is missing", () => {
    const s = sync(new ExplicitPredecessorRule());
    s.onSnapshot(snapshot(100));
    expect(() => s.onDelta(delta(105, [], [], null))).toThrow(/wrong rule/i);
  });
});

describe("Synchroniser — lifecycle", () => {
  it("reset returns to disconnected", () => {
    const s = sync();
    s.onSnapshot(snapshot(100));
    s.onDelta(delta(101));
    s.reset();
    expect(s.syncState).toBe(SyncState.Disconnected);
    expect(s.book.bestBid()).toBeNull();
    expect(s.lastApplied).toBeNull();
    expect(s.bufferedCount).toBe(0);
  });
});
