/**
 * Coinbase Advanced Trade market data adapter.
 *
 * Two responsibilities:
 *   1. Parse the REST L2 snapshot into a neutral Snapshot.
 *   2. Parse the WebSocket `level2` channel updates into neutral DepthDeltas.
 *
 * Coinbase uses a monotonically increasing `sequence` number per product,
 * shared between the snapshot and the diff stream. That is the cleanest
 * possible venue for this project — the sequencing rule is straight
 * adjacency and there is no futures-vs-spot split to worry about.
 *
 * The adapter is written to be venue-agnostic in shape: swapping in Kraken
 * or Bybit later is a matter of adding a new file next to this one and
 * pointing the app at it.
 */

import type {
  DepthDelta,
  Instrument,
  PriceSize,
  SequenceId,
  Snapshot,
} from "../types.js";

/**
 * Response shape from `GET /api/v3/brokerage/market/product_book`.
 *
 * Coinbase also serves a legacy Exchange endpoint at
 * `api.exchange.coinbase.com/products/{id}/book?level=2` which uses the
 * same neutral shape below. Both are supported by picking the parser at
 * the network boundary; this file expects the already-normalised form.
 */
export interface CoinbaseSnapshotPayload {
  /** ISO 8601 timestamp string. Coinbase's snapshot response uses `time`. */
  readonly time?: string;
  readonly sequence: number | string;
  readonly bids: ReadonlyArray<readonly [string, string, ...unknown[]]>;
  readonly asks: ReadonlyArray<readonly [string, string, ...unknown[]]>;
}

/**
 * A single message from the `level2` websocket channel. Coinbase batches
 * multiple `changes` per message, each of which is `[side, price, size]`.
 * A size of "0" means the level is removed. The message carries one
 * `sequence` for the whole batch.
 */
export interface CoinbaseL2Message {
  readonly type: "l2update" | "snapshot" | string;
  readonly product_id: string;
  readonly time: string;
  readonly sequence?: number | string;
  readonly changes?: ReadonlyArray<readonly [string, string, string]>;
  readonly bids?: ReadonlyArray<readonly [string, string]>;
  readonly asks?: ReadonlyArray<readonly [string, string]>;
}

export function parseSnapshot(
  payload: CoinbaseSnapshotPayload,
  instrument: Instrument,
): Snapshot {
  const sequence = coerceSequence(payload.sequence, "snapshot sequence");
  const eventTimeMs = payload.time ? Date.parse(payload.time) : Date.now();
  return {
    sequence,
    eventTimeMs,
    bids: parseLevels(payload.bids, instrument),
    asks: parseLevels(payload.asks, instrument),
  };
}

/**
 * Parse an l2update message into a DepthDelta.
 *
 * Coinbase's changes come as ["buy" | "sell", price, size]; snapshots
 * arrive on the same channel under `type: "snapshot"` with separate
 * bids/asks arrays and no sequence, which is handled by the caller.
 *
 * The public `level2_batch` channel does not carry per-message sequences,
 * so the caller may pass an explicit `synthesizedSequence` derived from
 * arrival order. TCP ordering is authoritative for that stream, and the
 * REST snapshot's monotone sequence anchors the count. When the message
 * itself has a sequence field (Advanced Trade's `level2` channel does),
 * it takes precedence.
 */
export function parseL2Update(
  message: CoinbaseL2Message,
  instrument: Instrument,
  synthesizedSequence?: SequenceId,
): DepthDelta {
  if (message.type !== "l2update") {
    throw new Error(`parseL2Update: expected l2update, got ${message.type}`);
  }
  const rawSequence = message.sequence ?? synthesizedSequence;
  if (rawSequence === undefined) {
    throw new Error("l2update without a sequence and no synthesized fallback");
  }
  const sequence = coerceSequence(rawSequence, "l2update sequence");
  const eventTimeMs = Date.parse(message.time);
  const changes = message.changes ?? [];
  const bids: PriceSize[] = [];
  const asks: PriceSize[] = [];
  for (const [side, priceStr, sizeStr] of changes) {
    // Coinbase sometimes reports a size at a price the instrument's own
    // tick would reject as off-grid, because their tick can widen for
    // large or illiquid markets. Snap rather than reject.
    const price = instrument.snapTicks(priceStr);
    const size = instrument.snapLots(sizeStr);
    const level: PriceSize = { price, size };
    if (side === "buy") bids.push(level);
    else if (side === "sell") asks.push(level);
    else throw new Error(`unknown side in l2update: ${side}`);
  }
  return {
    sequence,
    // Coinbase does not name a predecessor; adjacency is implicit and the
    // InferredContinuityRule handles it. Passing null tells the rule to
    // use `sequence` itself as both start and end of the covered range.
    previousSequence: null,
    eventTimeMs,
    bids,
    asks,
  };
}

/**
 * Coinbase's websocket first message on subscribe is `type: snapshot`,
 * shaped like a snapshot but arriving on the diff channel. This handles
 * that case, converting it into the same Snapshot type used by the REST
 * fetcher. Note that this snapshot has no sequence — the *next* l2update
 * carries the sequence that should be treated as its anchor, so we return
 * null and let the sequencing layer use the first delta's sequence.
 */
export function parseWebsocketSnapshot(
  message: CoinbaseL2Message,
  instrument: Instrument,
  fallbackSequence: SequenceId,
): Snapshot {
  if (message.type !== "snapshot") {
    throw new Error(`parseWebsocketSnapshot: expected snapshot, got ${message.type}`);
  }
  return {
    sequence: fallbackSequence,
    eventTimeMs: Date.parse(message.time),
    bids: parseLevels(message.bids ?? [], instrument),
    asks: parseLevels(message.asks ?? [], instrument),
  };
}

// ---- internals ----------------------------------------------------------

function parseLevels(
  rows: ReadonlyArray<readonly [string, string, ...unknown[]]>,
  instrument: Instrument,
): PriceSize[] {
  const out: PriceSize[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    out[i] = {
      price: instrument.snapTicks(row[0]),
      size: instrument.snapLots(row[1]),
    };
  }
  return out.filter((l) => l.size > 0);
}

function coerceSequence(raw: number | string, context: string): SequenceId {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${context}: not a valid sequence: ${raw}`);
  }
  return value;
}
