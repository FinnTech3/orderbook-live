/**
 * The top-level object the UI holds.
 *
 * Owns a Book, a Synchroniser, and a WebSocket to a venue. Exposes
 * subscribe() so the UI can re-render on every update without owning any of
 * the sequencing logic. The class is deliberately dumb in shape: it does
 * not know what a chart is, it only says "here's the new state, do
 * whatever." That keeps the design work separable from the systems work.
 *
 * Reconnection is aggressive by design: a dead socket produces a stale
 * book, and a stale book is worse than no book. On disconnect we drop the
 * book, back off exponentially, and start again from a fresh snapshot.
 */

import { OrderBook } from "./book.js";
import { InferredContinuityRule, Synchroniser, SyncState } from "./sequencing.js";
import type { Gap } from "./sequencing.js";
import type { DepthDelta, Instrument, Snapshot } from "./types.js";
import { parseL2Update, parseSnapshot, parseWebsocketSnapshot } from "./venues/coinbase.js";
import type { CoinbaseL2Message, CoinbaseSnapshotPayload } from "./venues/coinbase.js";

export interface FeedListener {
  onState(state: FeedState): void;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "loading-snapshot"
  | "reconciling"
  | "live"
  | "resyncing"
  | "error";

export interface FeedState {
  readonly status: ConnectionStatus;
  readonly book: OrderBook;
  readonly sync: SyncState;
  readonly lastMessageAgeMs: number | null;
  readonly gapsDetected: number;
  readonly messagesReceived: number;
  readonly errorMessage: string | null;
}

export interface FeedOptions {
  readonly instrument: Instrument;
  /** Product ID in Coinbase's format, e.g. "BTC-USD". */
  readonly productId: string;
  /** Overrides the default endpoints — used for tests, and for future
   *  Fly.io snapshot-proxy support. */
  readonly snapshotUrl?: string;
  readonly websocketUrl?: string;
  /** For dependency injection in tests. */
  readonly fetchImpl?: typeof fetch;
  readonly websocketImpl?: WebSocketFactory;
  /** ms between reconnect attempts, starting value. Doubles up to 30s. */
  readonly reconnectBaseMs?: number;
  /** ms after which the UI considers the feed stale. */
  readonly staleAfterMs?: number;
}

export type WebSocketFactory = new (url: string) => WebSocketLike;

/** Structural subset of the DOM/Node WebSocket. Kept small on purpose so
 *  a fake is easy to write. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "open", handler: () => void): void;
  addEventListener(event: "close", handler: (e: { code: number; reason: string }) => void): void;
  addEventListener(event: "error", handler: (e: unknown) => void): void;
  addEventListener(event: "message", handler: (e: { data: string }) => void): void;
}

const DEFAULT_SNAPSHOT_URL = "https://api.exchange.coinbase.com/products";
const DEFAULT_WEBSOCKET_URL = "wss://ws-feed.exchange.coinbase.com";

export class Feed {
  private readonly options: Required<Omit<FeedOptions, "fetchImpl" | "websocketImpl">> & {
    fetchImpl: typeof fetch;
    websocketImpl: WebSocketFactory;
  };
  private readonly book: OrderBook;
  private readonly sync: Synchroniser;
  private readonly listeners = new Set<FeedListener>();
  private socket: WebSocketLike | null = null;
  private status: ConnectionStatus = "disconnected";
  private errorMessage: string | null = null;
  private lastMessageMs: number | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Deltas received before the snapshot arrives. Buffered so the
   *  reconciliation step has everything it needs. */
  private pendingBeforeSnapshot: DepthDelta[] = [];
  /** Monotone counter for the batched feed's synthesized sequences. */
  private nextSynthesizedSeq: number | null = null;

  constructor(options: FeedOptions) {
    this.book = new OrderBook(options.instrument);
    this.sync = new Synchroniser(this.book, new InferredContinuityRule(), {
      onGap: (gap) => this.onGap(gap),
    });
    this.options = {
      instrument: options.instrument,
      productId: options.productId,
      snapshotUrl: options.snapshotUrl ?? DEFAULT_SNAPSHOT_URL,
      websocketUrl: options.websocketUrl ?? DEFAULT_WEBSOCKET_URL,
      fetchImpl: options.fetchImpl
        ?? (typeof fetch === "function"
          ? fetch.bind(globalThis)
          : (() => { throw new Error("no fetch available"); })),
      websocketImpl: options.websocketImpl
        ?? ((typeof WebSocket !== "undefined"
          ? (WebSocket as unknown as WebSocketFactory)
          : (() => { throw new Error("no WebSocket available"); })())),
      reconnectBaseMs: options.reconnectBaseMs ?? 500,
      staleAfterMs: options.staleAfterMs ?? 5_000,
    };
  }

  getBook(): OrderBook { return this.book; }
  getState(): FeedState {
    return {
      status: this.status,
      book: this.book,
      sync: this.sync.syncState,
      lastMessageAgeMs: this.lastMessageMs === null
        ? null
        : Date.now() - this.lastMessageMs,
      gapsDetected: this.sync.stats.gapsDetected,
      messagesReceived: this.sync.stats.deltasSeen,
      errorMessage: this.errorMessage,
    };
  }

  subscribe(listener: FeedListener): () => void {
    this.listeners.add(listener);
    // Fire once so the UI has state without waiting for the first event.
    listener.onState(this.getState());
    return () => { this.listeners.delete(listener); };
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("cannot restart a stopped feed");
    if (this.socket !== null) return;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket !== null) {
      try { this.socket.close(1000, "client stop"); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  /** Public for tests only. Real code path is the WebSocket handler. */
  ingestSnapshot(payload: CoinbaseSnapshotPayload): void {
    const snapshot = parseSnapshot(payload, this.options.instrument);
    this.reconcile(snapshot);
  }

  /** Public for tests only. */
  ingestL2(message: CoinbaseL2Message): void {
    if (message.type !== "l2update") return;
    const synth = message.sequence === undefined
      ? this.mintSynthesizedSequence()
      : undefined;
    const delta = parseL2Update(message, this.options.instrument, synth);
    this.lastMessageMs = Date.now();
    if (this.sync.syncState !== SyncState.Synced) {
      this.pendingBeforeSnapshot.push(delta);
      this.sync.onDelta(delta);
    } else {
      this.sync.onDelta(delta);
    }
    this.notify();
  }

  // ---- internals -------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");

    let socket: WebSocketLike;
    try {
      socket = new this.options.websocketImpl(this.options.websocketUrl);
    } catch (err) {
      this.errorMessage = errorMessage(err);
      this.setStatus("error");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => this.onOpen());
    socket.addEventListener("close", (e) => this.onClose(e.code, e.reason));
    socket.addEventListener("error", (e) => this.onError(e));
    socket.addEventListener("message", (e) => this.onMessage(e.data));
  }

  private onOpen(): void {
    this.reconnectAttempt = 0;
    // `level2_batch` is the public batched feed (~50ms coalescing). It
    // omits per-message sequences, so the ingest path synthesizes them
    // from arrival order and trusts TCP ordering; a periodic REST snapshot
    // catches any drift. The authenticated `level2` channel would give
    // real sequences but is not a free-tier option.
    const subscription = {
      type: "subscribe",
      product_ids: [this.options.productId],
      channels: ["level2_batch"],
    };
    try {
      this.socket!.send(JSON.stringify(subscription));
    } catch (err) {
      this.errorMessage = errorMessage(err);
      this.setStatus("error");
      return;
    }
    // The batched channel's own `snapshot` message anchors the book. We
    // deliberately don't fetch the REST snapshot here — with no per-message
    // sequences on `level2_batch`, the REST snapshot can't be aligned with
    // the diff stream, and mixing them produces crossed books.
    this.setStatus("loading-snapshot");
  }

  private async fetchSnapshot(): Promise<void> {
    const url =
      `${this.options.snapshotUrl}/${this.options.productId}/book?level=2`;
    const response = await this.options.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`snapshot HTTP ${response.status}`);
    }
    const payload = (await response.json()) as CoinbaseSnapshotPayload;
    this.ingestSnapshot(payload);
  }

  /** Next synthetic sequence to hand parseL2Update when the venue omits
   *  its own. Starts one above the last snapshot sequence so it stays
   *  monotone across a resync. Falls back to a fresh count if we have no
   *  snapshot yet, which is fine because the sync layer buffers until one
   *  arrives. */
  private mintSynthesizedSequence(): number {
    if (this.nextSynthesizedSeq === null) {
      const last = this.book.lastSequence();
      this.nextSynthesizedSeq = last !== null ? last + 1 : 1;
    }
    return this.nextSynthesizedSeq++;
  }

  private reconcile(snapshot: Snapshot): void {
    this.setStatus("reconciling");
    // Restart the synthetic counter above the new snapshot so buffered
    // pre-snapshot deltas don't collide with post-snapshot ones.
    this.nextSynthesizedSeq = snapshot.sequence + 1;
    const ok = this.sync.onSnapshot(snapshot);
    if (!ok) {
      // Snapshot landed in a hole. Coinbase's public snapshot endpoint
      // does not always return the very latest; refetch after a short
      // delay to catch up.
      setTimeout(() => {
        this.fetchSnapshot().catch((err) => {
          this.errorMessage = errorMessage(err);
          this.setStatus("error");
          this.scheduleReconnect();
        });
      }, 250);
      return;
    }
    this.pendingBeforeSnapshot = [];
    this.setStatus("live");
    this.notify();
  }

  private onMessage(data: string): void {
    let message: CoinbaseL2Message;
    try {
      message = JSON.parse(data) as CoinbaseL2Message;
    } catch (err) {
      this.errorMessage = `bad JSON: ${errorMessage(err)}`;
      return;
    }
    if (message.type === "subscriptions") return;
    if (message.type === "error") {
      this.errorMessage = `venue error: ${JSON.stringify(message)}`;
      this.setStatus("error");
      return;
    }
    if (message.type === "l2update") {
      this.ingestL2(message);
      return;
    }
    if (message.type === "snapshot") {
      // The WS snapshot is the anchor for the batched feed. It has no
      // sequence of its own, so we assign one from a synthetic counter
      // that then keeps rising with each subsequent diff.
      const seq = this.nextSynthesizedSeq ?? 1;
      this.nextSynthesizedSeq = seq + 1;
      const snapshot = parseWebsocketSnapshot(message, this.options.instrument, seq);
      this.reconcile(snapshot);
      return;
    }
  }

  private onClose(_code: number, reason: string): void {
    if (this.stopped) return;
    this.socket = null;
    this.errorMessage = reason || "socket closed";
    this.sync.reset();
    this.setStatus("disconnected");
    this.scheduleReconnect();
  }

  private onError(_event: unknown): void {
    // The `error` event does not carry useful info in browsers by design;
    // the `close` that follows will. Recorded here so the UI can say
    // something happened.
    this.errorMessage = "socket error";
    this.notify();
  }

  private onGap(gap: Gap): void {
    this.errorMessage =
      `gap: expected after ${gap.expectedAfter}, got ${gap.gotSequence} — resyncing`;
    this.setStatus("resyncing");
    // Since the batched feed's snapshot only arrives once per subscription,
    // recovering from a gap means reconnecting the socket so a fresh
    // snapshot is delivered. The socket close triggers reconnect naturally.
    if (this.socket !== null) {
      try { this.socket.close(1000, "resync"); } catch { /* ignore */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = Math.min(
      30_000,
      this.options.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.notify();
    }
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener.onState(state);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
