import { describe, expect, it } from "vitest";
import {
  ALL_MODELS,
  OptimisticQueue,
  PessimisticQueue,
  ProportionalQueue,
  byName,
  clamp,
} from "../src/lib/queue/models.js";

describe("clamp", () => {
  it("returns the preferred value when it is inside the feasible range", () => {
    // ahead=100, behind=100, cancelled=50 → range [0, 50]. Preferred 25 fits.
    expect(clamp(100, 100, 50, 25)).toBe(25);
  });

  it("floors at zero when preferred would be negative", () => {
    expect(clamp(100, 100, 50, -10)).toBe(0);
  });

  it("caps at what is arithmetically ahead", () => {
    // Only 10 lots ahead. Cannot cancel 40 of them.
    expect(clamp(10, 100, 40, 40)).toBe(10);
  });

  it("floors at cancelled minus behind when behind is small", () => {
    // 5 lots behind, 30 cancelled: at least 25 must be from ahead.
    expect(clamp(100, 5, 30, 0)).toBe(25);
  });

  it("throws when the request is impossible", () => {
    // Cannot cancel 100 from a queue holding 30.
    expect(() => clamp(10, 20, 100, 0)).toThrow(/cannot cancel/);
  });

  it("handles the empty-queue edge case", () => {
    expect(clamp(0, 0, 0, 0)).toBe(0);
  });
});

describe("queue models", () => {
  it("pessimistic assigns cancellations to behind first", () => {
    const m = new PessimisticQueue();
    // Room behind to absorb everything: nothing comes off the front.
    expect(m.cancellationsAhead(100, 100, 30)).toBe(0);
  });

  it("pessimistic is forced up when behind runs out", () => {
    const m = new PessimisticQueue();
    // 5 behind, 30 cancels: 25 must be from ahead.
    expect(m.cancellationsAhead(100, 5, 30)).toBe(25);
  });

  it("optimistic takes from ahead wherever possible", () => {
    const m = new OptimisticQueue();
    expect(m.cancellationsAhead(100, 100, 30)).toBe(30);
  });

  it("optimistic caps at what is actually ahead", () => {
    const m = new OptimisticQueue();
    // Only 10 in front; cannot pull 30 from there.
    expect(m.cancellationsAhead(10, 100, 30)).toBe(10);
  });

  it("proportional splits by fraction ahead", () => {
    const m = new ProportionalQueue();
    // 100 ahead, 300 behind → 1/4 of cancels from ahead. 40 * 0.25 = 10.
    expect(m.cancellationsAhead(100, 300, 40)).toBe(10);
  });

  it("proportional rounds half-away-from-zero", () => {
    const m = new ProportionalQueue();
    // 3 ahead of 6 total, cancelling 3 → 3 * 0.5 = 1.5 rounds to 2.
    expect(m.cancellationsAhead(3, 3, 3)).toBe(2);
  });

  it("proportional handles an empty queue without dividing by zero", () => {
    const m = new ProportionalQueue();
    expect(m.cancellationsAhead(0, 0, 0)).toBe(0);
  });

  it("pessimistic ≤ proportional ≤ optimistic under normal loads", () => {
    const [pess, prop, opt] = [
      new PessimisticQueue(),
      new ProportionalQueue(),
      new OptimisticQueue(),
    ];
    for (const [a, b, c] of [
      [50, 50, 20],
      [100, 25, 30],
      [200, 200, 50],
      [10, 500, 5],
    ] as const) {
      const p = pess.cancellationsAhead(a, b, c);
      const q = prop.cancellationsAhead(a, b, c);
      const o = opt.cancellationsAhead(a, b, c);
      expect(p).toBeLessThanOrEqual(q);
      expect(q).toBeLessThanOrEqual(o);
    }
  });
});

describe("model registry", () => {
  it("ALL_MODELS is ordered worst-to-best for a passive placer", () => {
    expect(ALL_MODELS.map((m) => m.name)).toEqual([
      "pessimistic",
      "proportional",
      "optimistic",
    ]);
  });

  it("byName finds registered models", () => {
    expect(byName("pessimistic")).toBeInstanceOf(PessimisticQueue);
    expect(byName("optimistic")).toBeInstanceOf(OptimisticQueue);
    expect(byName("proportional")).toBeInstanceOf(ProportionalQueue);
  });

  it("byName rejects unknown names with a helpful message", () => {
    expect(() => byName("miracle")).toThrow(/pessimistic.*proportional.*optimistic/);
  });
});
