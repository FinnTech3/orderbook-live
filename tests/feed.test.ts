import { describe, expect, it } from "vitest";
import { Feed } from "../src/lib/feed.js";
import type { FeedState, WebSocketLike } from "../src/lib/feed.js";
import { Instrument, Side } from "../src/lib/types.js";
import type { CoinbaseL2Message, CoinbaseSnapshotPayload } from "../src/lib/venues/coinbase.js";

const BTC = new Instrument("BTC-USD", "0.01", "0.00000001");

/**
 * Minimal fake WebSocket that captures listeners and lets tests drive
 * them at will. Only the surface Feed uses is implemented.
 */
class FakeSocket implements WebSocketLike {
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  private handlers: {
    open: Array<() => void>;
    close: Array<(e: { code: number; reason: string }) => void>;
    error: Array<(e: unknown) => void>;
    message: Array<(e: { data: string }) => void>;
  } = { open: [], close: [], error: [], message: [] };

  static readonly instances: FakeSocket[] = [];

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }

  // Overloaded to match the DOM shape without eating type safety.
  addEventListener(event: "open", handler: () => void): void;
  addEventListener(event: "close", handler: (e: { code: number; reason: string }) => void): void;
  addEventListener(event: "error", handler: (e: unknown) => void): void;
  addEventListener(event: "message", handler: (e: { data: string }) => void): void;
  addEventListener(event: string, handler: (e: never) => void): void {
    // Cast is safe: the four overloads above are the only allowed events.
    (this.handlers as Record<string, Array<(e: unknown) => void>>)[event]!.push(
      handler as (e: unknown) => void,
    );
  }

  fireOpen(): void {
    this.readyState = 1;
    for (const h of this.handlers.open) h();
  }
  fireMessage(data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const h of this.handlers.message) h({ data: payload });
  }
  fireClose(code = 1006, reason = "test close"): void {
    this.readyState = 3;
    for (const h of this.handlers.close) h({ code, reason });
  }
}

function fakeFetch(payload: CoinbaseSnapshotPayload): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function collect(feed: Feed): FeedState[] {
  const seen: FeedState[] = [];
  feed.subscribe({ onState: (s) => seen.push(s) });
  return seen;
}

function makeFeed(payload: CoinbaseSnapshotPayload): { feed: Feed; states: FeedState[] } {
  // Reset the module-level instance list for isolation.
  FakeSocket.instances.length = 0;
  const feed = new Feed({
    instrument: BTC,
    productId: "BTC-USD",
    fetchImpl: fakeFetch(payload),
    websocketImpl: FakeSocket as unknown as new (url: string) => WebSocketLike,
    reconnectBaseMs: 10,
  });
  const states = collect(feed);
  return { feed, states };
}

const SNAP_PAYLOAD: CoinbaseSnapshotPayload = {
  sequence: 100,
  time: "2026-08-06T12:00:00Z",
  bids: [
    ["64000.00", "1.0"],
    ["63999.00", "0.5"],
  ],
  asks: [
    ["64001.00", "0.75"],
  ],
};

const l2 = (
  sequence: number,
  changes: ReadonlyArray<readonly [string, string, string]>,
): CoinbaseL2Message => ({
  type: "l2update",
  product_id: "BTC-USD",
  time: "2026-08-06T12:00:01Z",
  sequence,
  changes,
});

describe("Feed, ingestion", () => {
  it("applies a snapshot and then a delta, in order", () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    feed.ingestSnapshot(SNAP_PAYLOAD);
    expect(feed.getBook().bestBid()).toBe(BTC.toTicks("64000.00"));

    feed.ingestL2(l2(101, [["buy", "64000.00", "0"]]));
    expect(feed.getBook().sizeAt(Side.Bid, BTC.toTicks("64000.00"))).toBe(0);
    expect(feed.getBook().bestBid()).toBe(BTC.toTicks("63999.00"));
  });

  it("buffers pre-snapshot deltas and drains them", () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    // Deltas arrive before the snapshot is applied.
    feed.ingestL2(l2(101, [["sell", "64001.00", "0"]]));
    feed.ingestL2(l2(102, [["sell", "64002.00", "2.0"]]));
    feed.ingestSnapshot(SNAP_PAYLOAD);

    // The buffered 101/102 should apply on top of the snapshot at 100.
    expect(feed.getBook().sizeAt(Side.Ask, BTC.toTicks("64001.00"))).toBe(0);
    expect(feed.getBook().sizeAt(Side.Ask, BTC.toTicks("64002.00")))
      .toBe(BTC.toLots("2.0"));
  });

  it("state reports live once synced", () => {
    const { feed, states } = makeFeed(SNAP_PAYLOAD);
    feed.ingestSnapshot(SNAP_PAYLOAD);
    // The subscriber sees one initial state plus at least one live state.
    expect(states.some((s) => s.status === "live")).toBe(true);
  });

  it("synthesizes sequences for messages without one", () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    feed.ingestSnapshot(SNAP_PAYLOAD); // seq 100
    // Two updates without their own sequences; the Feed should mint 101, 102.
    feed.ingestL2({
      type: "l2update",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:01Z",
      changes: [["buy", "63998.00", "1.0"]],
    });
    feed.ingestL2({
      type: "l2update",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:01Z",
      changes: [["buy", "63997.00", "2.0"]],
    });
    expect(feed.getBook().lastSequence()).toBe(102);
    expect(feed.getBook().sizeAt(Side.Bid, BTC.toTicks("63997.00")))
      .toBe(BTC.toLots("2.0"));
  });

  it("ignores non-l2update messages passed to ingestL2", () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    feed.ingestSnapshot(SNAP_PAYLOAD);
    const before = feed.getState().messagesReceived;
    feed.ingestL2({
      type: "heartbeat",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:01Z",
    } as unknown as CoinbaseL2Message);
    expect(feed.getState().messagesReceived).toBe(before);
  });
});

describe("Feed, WebSocket lifecycle", () => {
  it("opens a socket and subscribes to the product on open", async () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    await feed.start();
    const socket = FakeSocket.instances[0]!;
    socket.fireOpen();
    expect(socket.sent).toHaveLength(1);
    const msg = JSON.parse(socket.sent[0]!) as { channels: string[]; product_ids: string[] };
    expect(msg.product_ids).toEqual(["BTC-USD"]);
    expect(msg.channels).toContain("level2_batch");
    feed.stop();
  });

  it("close after start puts the feed into disconnected", async () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    await feed.start();
    FakeSocket.instances[0]!.fireOpen();
    FakeSocket.instances[0]!.fireClose();
    expect(feed.getState().status).toBe("disconnected");
    feed.stop();
  });

  it("stop() prevents further reconnection", async () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    await feed.start();
    FakeSocket.instances[0]!.fireOpen();
    feed.stop();
    FakeSocket.instances[0]!.fireClose();
    // No new socket should be created after stop.
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("Feed, message routing", () => {
  it("routes l2update messages through the ingest path", async () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    await feed.start();
    const socket = FakeSocket.instances[0]!;
    socket.fireOpen();
    // For level2_batch, the WS snapshot is the anchor. Deliver it, then
    // a diff, and check the book reflects both.
    socket.fireMessage({
      type: "snapshot",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:00Z",
      bids: [["64000.00", "1.0"]],
      asks: [["64001.00", "1.0"]],
    });
    // A real level2_batch diff has no sequence field.
    socket.fireMessage({
      type: "l2update",
      product_id: "BTC-USD",
      time: "2026-08-06T12:00:01Z",
      changes: [["buy", "63998.00", "3.0"]],
    });
    expect(feed.getBook().sizeAt(Side.Bid, BTC.toTicks("63998.00")))
      .toBe(BTC.toLots("3.0"));
    feed.stop();
  });

  it("ignores subscriptions confirmations", async () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    await feed.start();
    const socket = FakeSocket.instances[0]!;
    socket.fireOpen();
    await new Promise((r) => setTimeout(r, 5));

    const before = feed.getState().messagesReceived;
    socket.fireMessage({ type: "subscriptions", channels: [] });
    expect(feed.getState().messagesReceived).toBe(before);
    feed.stop();
  });

  it("surfaces malformed JSON as an error message but keeps running", async () => {
    const { feed } = makeFeed(SNAP_PAYLOAD);
    await feed.start();
    const socket = FakeSocket.instances[0]!;
    socket.fireOpen();
    await new Promise((r) => setTimeout(r, 5));

    socket.fireMessage("{not-json");
    expect(feed.getState().errorMessage).toMatch(/JSON/);
    feed.stop();
  });
});
