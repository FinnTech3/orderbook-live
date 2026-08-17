/**
 * Getting the events into the right order, and noticing when they are not.
 *
 * A depth stream is only useful if you can prove you have every message.
 * This module owns that proof. It buffers deltas until a snapshot arrives,
 * discards the ones the snapshot already accounts for, identifies the single
 * delta that straddles the snapshot, and from then on refuses to apply
 * anything that does not follow the last message applied.
 *
 * Venues express continuity differently. The rule for a given venue is a
 * SequenceRule object, so adding a venue does not touch the state machine.
 * The two included here cover almost every venue in practice: adjacency
 * (Coinbase, Binance spot) and explicit predecessor ID (Binance futures).
 */

import { OrderBook } from "./book.js";
import type { DepthDelta, SequenceId, Snapshot } from "./types.js";

export const enum SyncState {
  /** No book, no snapshot. Deltas are buffered. */
  Disconnected = "disconnected",
  /** Deltas queued while we wait for a snapshot to anchor them. */
  Buffering = "buffering",
  /** Book is live and every delta since the snapshot has been accounted for. */
  Synced = "synced",
}

export interface SequenceRule {
  /** True if the snapshot's last sequence already includes this delta. */
  isStale(snapshotSequence: SequenceId, delta: DepthDelta): boolean;
  /** True if this delta is the correct first one to apply after the snapshot. */
  bridges(snapshotSequence: SequenceId, delta: DepthDelta): boolean;
  /** True if this delta directly follows the previous one applied. */
  follows(previousSequence: SequenceId, delta: DepthDelta): boolean;
}

/**
 * Continuity inferred from adjacency. Each delta covers a range of sequence
 * IDs (`previousSequence + 1 .. sequence`); the next delta must start
 * exactly one past where the previous one ended.
 *
 * Coinbase's `sequence` field works this way. So does Binance spot with `U`
 * and `u`.
 */
export class InferredContinuityRule implements SequenceRule {
  isStale(snapshotSequence: SequenceId, delta: DepthDelta): boolean {
    return delta.sequence <= snapshotSequence;
  }
  bridges(snapshotSequence: SequenceId, delta: DepthDelta): boolean {
    const first = delta.previousSequence === null
      ? delta.sequence
      : delta.previousSequence + 1;
    return first <= snapshotSequence + 1 && snapshotSequence + 1 <= delta.sequence;
  }
  follows(previousSequence: SequenceId, delta: DepthDelta): boolean {
    const first = delta.previousSequence === null
      ? delta.sequence
      : delta.previousSequence + 1;
    return first === previousSequence + 1;
  }
}

/**
 * Continuity stated outright by the venue. Each delta names the sequence
 * of the message that should precede it, so a gap is detected by mismatch
 * rather than arithmetic. Binance USD-M futures works this way. Stricter
 * than adjacency: catches a dropped message even if the IDs happen to line
 * up.
 */
export class ExplicitPredecessorRule implements SequenceRule {
  isStale(snapshotSequence: SequenceId, delta: DepthDelta): boolean {
    return delta.sequence < snapshotSequence;
  }
  bridges(snapshotSequence: SequenceId, delta: DepthDelta): boolean {
    if (delta.previousSequence === null) {
      throw new Error(
        "ExplicitPredecessorRule needs previousSequence; is the wrong rule wired?",
      );
    }
    return delta.previousSequence <= snapshotSequence
      && snapshotSequence <= delta.sequence;
  }
  follows(previousSequence: SequenceId, delta: DepthDelta): boolean {
    if (delta.previousSequence === null) {
      throw new Error(
        "ExplicitPredecessorRule needs previousSequence; is the wrong rule wired?",
      );
    }
    return delta.previousSequence === previousSequence;
  }
}

export interface Gap {
  readonly expectedAfter: SequenceId;
  readonly gotSequence: SequenceId;
  readonly eventTimeMs: number;
}

export interface SyncStats {
  deltasSeen: number;
  deltasApplied: number;
  deltasBuffered: number;
  /** Retransmitted by the venue after we had already applied them. */
  deltasDiscardedDuplicate: number;
  /** Superseded by a snapshot. Expected. */
  deltasDiscardedStale: number;
  /** Dropped because the buffer filled before a snapshot arrived. */
  deltasDroppedOverflow: number;
  /** Continuity broke. Each is a resynchronisation. */
  gapsDetected: number;
  snapshotsApplied: number;
  /** Snapshot arrived but could not be reconciled with the buffer. */
  snapshotsRejected: number;
  /** Buffer was not already in sequence order. Should be zero on a
   *  single connection. */
  outOfOrderArrivals: number;
}

const DEFAULT_MAX_BUFFER = 5_000;

/**
 * Drives an OrderBook from an unreliable stream. Feed it deltas and
 * snapshots in whatever order they arrive. It applies what it can prove is
 * correct, and asks for a new snapshot when it cannot.
 */
export class Synchroniser {
  readonly book: OrderBook;
  readonly rule: SequenceRule;
  readonly maxBuffer: number;
  readonly stats: SyncStats;
  private state: SyncState = SyncState.Disconnected;
  private buffer: DepthDelta[] = [];
  private lastAppliedSequence: SequenceId | null = null;
  private readonly onGap: ((gap: Gap) => void) | null;

  constructor(
    book: OrderBook,
    rule: SequenceRule = new InferredContinuityRule(),
    options: { maxBuffer?: number; onGap?: (gap: Gap) => void } = {},
  ) {
    this.book = book;
    this.rule = rule;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    if (this.maxBuffer < 1) throw new Error("maxBuffer must be at least 1");
    this.onGap = options.onGap ?? null;
    this.stats = {
      deltasSeen: 0,
      deltasApplied: 0,
      deltasBuffered: 0,
      deltasDiscardedDuplicate: 0,
      deltasDiscardedStale: 0,
      deltasDroppedOverflow: 0,
      gapsDetected: 0,
      snapshotsApplied: 0,
      snapshotsRejected: 0,
      outOfOrderArrivals: 0,
    };
  }

  get syncState(): SyncState { return this.state; }
  get bufferedCount(): number { return this.buffer.length; }
  get lastApplied(): SequenceId | null { return this.lastAppliedSequence; }
  get needsSnapshot(): boolean { return this.state !== SyncState.Synced; }

  onDelta(delta: DepthDelta): boolean {
    this.stats.deltasSeen++;

    if (this.state === SyncState.Synced) {
      const previous = this.lastAppliedSequence!;

      // A duplicate is not a gap. Venues retransmit after reconnects, and
      // tearing down a good book over a harmless replay turns a friendly
      // event into a real outage.
      if (delta.sequence <= previous) {
        this.stats.deltasDiscardedDuplicate++;
        return false;
      }

      if (this.rule.follows(previous, delta)) {
        this.book.applyDelta(delta);
        this.lastAppliedSequence = delta.sequence;
        this.stats.deltasApplied++;
        return true;
      }

      this.handleGap(delta);
      return false;
    }

    this.bufferDelta(delta);
    return false;
  }

  /**
   * A snapshot only usable if the buffer can be joined to it without a
   * hole. If the earliest buffered delta starts *after* the snapshot ends,
   * messages were lost in between and no replay can recover them - reject
   * the snapshot and keep buffering. The caller should fetch a newer one.
   */
  onSnapshot(snapshot: Snapshot): boolean {
    if (this.state === SyncState.Synced) return true;

    const ordered = this.orderedBuffer();
    const fresh = ordered.filter(
      (d) => !this.rule.isStale(snapshot.sequence, d),
    );
    this.stats.deltasDiscardedStale += ordered.length - fresh.length;

    if (fresh.length > 0 && !this.rule.bridges(snapshot.sequence, fresh[0]!)) {
      // The snapshot lands in a hole. Keep buffering; ask again.
      this.stats.snapshotsRejected++;
      this.buffer = fresh;
      this.state = SyncState.Buffering;
      return false;
    }

    this.book.loadSnapshot(snapshot);
    this.lastAppliedSequence = snapshot.sequence;
    this.stats.snapshotsApplied++;

    for (let i = 0; i < fresh.length; i++) {
      const delta = fresh[i]!;
      const isBridge = i === 0 && this.rule.bridges(snapshot.sequence, delta);
      if (!isBridge && !this.rule.follows(this.lastAppliedSequence!, delta)) {
        this.handleGap(delta);
        return false;
      }
      this.book.applyDelta(delta);
      this.lastAppliedSequence = delta.sequence;
      this.stats.deltasApplied++;
    }

    this.buffer = [];
    this.state = SyncState.Synced;
    return true;
  }

  reset(): void {
    this.book.clear();
    this.buffer = [];
    this.lastAppliedSequence = null;
    this.state = SyncState.Disconnected;
  }

  private bufferDelta(delta: DepthDelta): void {
    if (this.buffer.length >= this.maxBuffer) {
      // Drop the oldest - a future snapshot is most likely to supersede
      // them anyway.
      this.buffer.shift();
      this.stats.deltasDroppedOverflow++;
    }
    this.buffer.push(delta);
    this.stats.deltasBuffered++;
    if (this.state === SyncState.Disconnected) {
      this.state = SyncState.Buffering;
    }
  }

  private orderedBuffer(): DepthDelta[] {
    const arr = this.buffer.slice();
    let sorted = true;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i]!.sequence < arr[i - 1]!.sequence) { sorted = false; break; }
    }
    if (!sorted) {
      this.stats.outOfOrderArrivals++;
      arr.sort((a, b) => a.sequence - b.sequence);
    }
    return arr;
  }

  private handleGap(delta: DepthDelta): void {
    const expected = this.lastAppliedSequence!;
    this.stats.gapsDetected++;
    this.book.clear();
    this.buffer = [];
    this.lastAppliedSequence = null;
    this.state = SyncState.Buffering;
    // The delta that exposed the gap is still needed once we resync.
    this.bufferDelta(delta);
    if (this.onGap) {
      this.onGap({
        expectedAfter: expected,
        gotSequence: delta.sequence,
        eventTimeMs: delta.eventTimeMs,
      });
    }
  }
}
