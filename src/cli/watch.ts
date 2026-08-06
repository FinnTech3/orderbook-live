/**
 * Headless demo: connect to Coinbase, print top of book at 500ms intervals.
 *
 * Exists so the backend can be verified from a terminal, no UI, no browser.
 * Also useful for capturing fixture data — pipe it to a file, then edit the
 * capture into a test.
 *
 * Usage:
 *   npx tsx src/cli/watch.ts BTC-USD --seconds 10
 */
import { WebSocket } from "ws";
import { Feed } from "../lib/feed.js";
import { estimateFill } from "../lib/queue/fill.js";
import { Instrument, Side } from "../lib/types.js";

const KNOWN: Record<string, Instrument> = {
  "BTC-USD": new Instrument("BTC-USD", "0.01", "0.00000001"),
  "ETH-USD": new Instrument("ETH-USD", "0.01", "0.00000001"),
  "SOL-USD": new Instrument("SOL-USD", "0.01", "0.00000001"),
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const productId = args[0] ?? "BTC-USD";
  const secondsFlag = args.indexOf("--seconds");
  const seconds = secondsFlag >= 0 ? Number(args[secondsFlag + 1]) : 15;

  const instrument = KNOWN[productId];
  if (!instrument) {
    console.error(`unknown product ${productId}; known: ${Object.keys(KNOWN).join(", ")}`);
    process.exit(2);
  }

  const feed = new Feed({
    instrument,
    productId,
    websocketImpl: WebSocket as unknown as new (url: string) => import("../lib/feed.js").WebSocketLike,
  });

  const interval = setInterval(() => {
    const state = feed.getState();
    const book = state.book;
    const bid = book.bestBid();
    const ask = book.bestAsk();
    const line = {
      t: new Date().toISOString(),
      status: state.status,
      seq: book.lastSequence(),
      bid: bid !== null ? instrument.formatPrice(bid) : null,
      ask: ask !== null ? instrument.formatPrice(ask) : null,
      spread: book.spread(),
      mid: book.mid(),
      microprice: book.microprice()?.toFixed(4) ?? null,
      imbalance: book.imbalance(5)?.toFixed(4) ?? null,
      gaps: state.gapsDetected,
      msgs: state.messagesReceived,
    };
    // If both sides are populated, also print a sample fill estimate for a
    // small passive bid one tick below the touch. Useful sanity check.
    if (bid !== null && ask !== null) {
      const range = estimateFill(book, {
        side: Side.Bid,
        price: bid - 1,
        size: instrument.toLots("0.05"),
        volumeBudget: instrument.toLots("2"),
      });
      Object.assign(line, {
        fillLow: range.low.toFixed(3),
        fillHigh: range.high.toFixed(3),
      });
    }
    console.log(JSON.stringify(line));
  }, 500);

  const stop = (): void => {
    clearInterval(interval);
    feed.stop();
    process.exit(0);
  };
  setTimeout(stop, seconds * 1_000);
  process.on("SIGINT", stop);

  await feed.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
