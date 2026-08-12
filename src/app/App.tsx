/**
 * The one screen. Built to the Order Book Probe design spec — tokens,
 * layout, motion, and information density are all set by the brief; only
 * the data plumbing is code I owned to write.
 *
 * The stand-ins from the design prototype (SimBook, an inline queue-model
 * estimator) are gone: the render layer talks directly to `Feed` and
 * `estimateFill` from ../lib, which are what the systems work on this
 * project actually built.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Feed } from "../lib/feed.js";
import type { FeedState } from "../lib/feed.js";
import { estimateFill } from "../lib/queue/fill.js";
import type { FillEstimate, FillRange } from "../lib/queue/fill.js";
import { Instrument, Side } from "../lib/types.js";

const BTC = new Instrument("BTC-USD", "0.01", "0.00000001");

/** Products offered in the header selector. Every Coinbase USD spot book here
 *  shares the same tick (0.01) and lot (1e-8) grid, so `BTC`'s Instrument
 *  doubles as the formatting grid for all of them; only the venue product id
 *  and the base-currency label change. */
export const PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
export type Product = (typeof PRODUCTS)[number];
const INSTRUMENTS: Record<Product, Instrument> = {
  "BTC-USD": BTC,
  "ETH-USD": new Instrument("ETH-USD", "0.01", "0.00000001"),
  "SOL-USD": new Instrument("SOL-USD", "0.01", "0.00000001"),
};
const baseOf = (product: Product): string => product.slice(0, product.indexOf("-"));

/** Optional feed override. Defaults to Coinbase's public feed; set at build
 *  time to point at a staging feed, a snapshot proxy, or a local replay
 *  (used for the README screenshots). Falls back to the venue default when
 *  unset, so a normal build needs no configuration. */
const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) || undefined;

// ─────────────────────────────── helpers ──────────────────────────────────

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function fmtPrice(ticks: number | null): string {
  if (ticks === null || !Number.isFinite(ticks)) return "—";
  return BTC.fromTicks(ticks).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtSize(lots: number, dp = 4): string {
  return BTC.fromLots(lots).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function toLots(input: string, fallback: number): number {
  try {
    return BTC.snapLots(input.trim() || String(fallback));
  } catch {
    return BTC.toLots(String(fallback));
  }
}

const MODEL_META: Record<string, { name: string; note: string }> = {
  pessimistic: {
    name: "FIFO / no cancellation",
    note: "lower bound · queue only drains by trades",
  },
  proportional: {
    name: "Uniform cancellation",
    note: "cancels split proportionally by queue position",
  },
  optimistic: {
    name: "Front-loaded cancel",
    note: "upper bound · cancels concentrate at queue head",
  },
};

// ────────────────────────────── the app ───────────────────────────────────

export function App(): JSX.Element {
  const [state, setState] = useState<FeedState | null>(null);
  const [msgsPerSec, setMsgsPerSec] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [vh, setVh] = useState<number>(typeof window === "undefined" ? 900 : window.innerHeight);
  const [clock, setClock] = useState<string>(() => new Date().toISOString().slice(11, 19) + "Z");

  const [product, setProduct] = useState<Product>("BTC-USD");
  const [side, setSide] = useState<Side>(Side.Bid);
  const [offset, setOffset] = useState<number>(2);
  // Defaults chosen so the first thing you see is an actual range across the
  // three models, not a saturated 100% — an order sized near the queue ahead
  // with a budget that only partly clears it is where the models disagree.
  const [sizeInput, setSizeInput] = useState("0.1500");
  const [budgetInput, setBudgetInput] = useState("0.2000");

  const feedRef = useRef<Feed | null>(null);
  const bookAgeAnchorRef = useRef<number | null>(null);
  const msgWindowRef = useRef<Array<[number, number]>>([]);
  const lastMsgCountRef = useRef<number>(0);

  // Root data-theme so the toggle overrides the OS preference immediately.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // The feed. Recreated whenever the selected product changes; the previous
  // one is torn down and all the running counters reset so the new book
  // starts from a clean slate rather than inheriting the old one's stats.
  useEffect(() => {
    bookAgeAnchorRef.current = null;
    lastMsgCountRef.current = 0;
    msgWindowRef.current = [];
    setState(null);
    setMsgsPerSec(0);

    const feed = new Feed({
      instrument: INSTRUMENTS[product],
      productId: product,
      ...(WS_URL ? { websocketUrl: WS_URL } : {}),
    });
    feedRef.current = feed;
    const off = feed.subscribe({
      onState(s) {
        setState(s);
        if (s.status === "live" && bookAgeAnchorRef.current === null) {
          bookAgeAnchorRef.current = Date.now();
        }
      },
    });
    feed.start().catch(() => {
      // The Feed reports errors through its state, so the UI shows them.
    });
    return () => {
      off();
      feed.stop();
      feedRef.current = null;
    };
  }, [product]);

  // Rolling 1s messages-per-second window and the UTC clock — both driven
  // by a single 500ms interval so the header ticks with the metrics rather
  // than on some other cadence.
  useEffect(() => {
    const tick = (): void => {
      const now = Date.now();
      const count = state?.messagesReceived ?? 0;
      const delta = count - lastMsgCountRef.current;
      lastMsgCountRef.current = count;
      msgWindowRef.current.push([now, delta]);
      while (msgWindowRef.current.length && now - msgWindowRef.current[0]![0] > 1000) {
        msgWindowRef.current.shift();
      }
      const sum = msgWindowRef.current.reduce((a, x) => a + x[1], 0);
      setMsgsPerSec(sum);
      setClock(new Date().toISOString().slice(11, 19) + "Z");
    };
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state?.messagesReceived]);

  // Viewport-driven level count.
  useEffect(() => {
    const onResize = (): void => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const depth = clamp(Math.floor((vh - 620) / 24), 10, 26);
  const imbalanceDepth = 10;

  // Derived render values, all null-safe against a pre-live book.
  const view = useMemo(() => derive({
    state, depth, imbalanceDepth, side, offset, sizeInput, budgetInput, product,
  }), [state, depth, imbalanceDepth, side, offset, sizeInput, budgetInput, product]);

  const bookAge = bookAgeAnchorRef.current === null
    ? "—"
    : `${Math.floor((Date.now() - bookAgeAnchorRef.current) / 1000)}s`;

  return (
    <>
      <ThemeStyles />
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "var(--t-body)",
          fontVariantNumeric: "tabular-nums",
          padding: "var(--s4)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--s3)",
          overflowX: "hidden",
        }}
      >
        <Header
          product={product}
          onProduct={setProduct}
          clock={clock}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />

        <div id="obp-grid" style={{ width: "100%", maxWidth: 1680 }}>
          <BidPanel rows={view.bidRows} />
          <MetricsPanel view={view} imbalanceDepth={imbalanceDepth} depth={depth} />
          <AskPanel rows={view.askRows} />
        </div>

        <div id="obp-bottom" style={{ width: "100%", maxWidth: 1680 }}>
          <ProbePanel
            side={side}
            onSide={setSide}
            offset={offset}
            onOffset={setOffset}
            probePriceLabel={view.probePriceLabel}
            sizeInput={sizeInput}
            onSizeInput={setSizeInput}
            budgetInput={budgetInput}
            onBudgetInput={setBudgetInput}
            sizeLotsLabel={view.sizeLotsLabel}
          />
          <HeroPanel view={view} />
        </div>

        <StatusStrip
          status={state?.status ?? "connecting"}
          seq={view.seqLabel}
          gaps={state?.gapsDetected ?? 0}
          msgs={state?.messagesReceived ?? 0}
          mps={msgsPerSec}
          bookAge={bookAge}
          errorMessage={state?.errorMessage ?? ""}
        />
      </div>
    </>
  );
}

// ─────────────────────────────── tokens ──────────────────────────────────

function ThemeStyles(): JSX.Element {
  return (
    <style>{`
      :root {
        --bg:#0a0c0d; --panel:#0f1214; --panel-2:#131719; --line:#1f2528; --line-2:#2b3236;
        --text:#c7d0d3; --text-hi:#eef3f4; --dim:#6a7679; --dim-2:#4a5457;
        --bid:#4f8f6b; --bid-bar:rgba(79,143,107,0.17);
        --ask:#b0645a; --ask-bar:rgba(176,100,90,0.17);
        --amber:#c99a3a; --accent:#7396c4; --accent-soft:rgba(115,150,196,0.16);
        --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:36px;
        --t-micro:9.5px; --t-label:10.5px; --t-body:12px; --t-num:13px;
        --t-lg:20px; --t-xl:30px; --t-hero:46px;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg:#f2f1ee; --panel:#fbfaf8; --panel-2:#f4f3f0; --line:#dedbd4; --line-2:#c9c5bc;
          --text:#2b3033; --text-hi:#101315; --dim:#6f7679; --dim-2:#9aa0a2;
          --bid:#2f6b4c; --bid-bar:rgba(47,107,76,0.13);
          --ask:#96473c; --ask-bar:rgba(150,71,60,0.13);
          --amber:#8a6512; --accent:#33557f; --accent-soft:rgba(51,85,127,0.14);
        }
      }
      :root[data-theme="dark"] {
        --bg:#0a0c0d; --panel:#0f1214; --panel-2:#131719; --line:#1f2528; --line-2:#2b3236;
        --text:#c7d0d3; --text-hi:#eef3f4; --dim:#6a7679; --dim-2:#4a5457;
        --bid:#4f8f6b; --bid-bar:rgba(79,143,107,0.17);
        --ask:#b0645a; --ask-bar:rgba(176,100,90,0.17);
        --amber:#c99a3a; --accent:#7396c4; --accent-soft:rgba(115,150,196,0.16);
      }
      :root[data-theme="light"] {
        --bg:#f2f1ee; --panel:#fbfaf8; --panel-2:#f4f3f0; --line:#dedbd4; --line-2:#c9c5bc;
        --text:#2b3033; --text-hi:#101315; --dim:#6f7679; --dim-2:#9aa0a2;
        --bid:#2f6b4c; --bid-bar:rgba(47,107,76,0.13);
        --ask:#96473c; --ask-bar:rgba(150,71,60,0.13);
        --amber:#8a6512; --accent:#33557f; --accent-soft:rgba(51,85,127,0.14);
      }
      html, body { margin:0; padding:0; background: var(--bg); }
      * { box-sizing: border-box; }
      input { font: inherit; }
      button { font: inherit; cursor: pointer; }
      #obp-grid {
        display: grid;
        grid-template-columns: minmax(0,1fr) 190px minmax(0,1fr);
        gap: var(--s3);
        align-items: start;
      }
      #obp-bottom {
        display: grid;
        grid-template-columns: minmax(320px,400px) minmax(0,1fr);
        gap: var(--s3);
        align-items: stretch;
      }
      #obp-hero {
        display: grid;
        grid-template-columns: minmax(0,1.1fr) minmax(0,1fr);
        gap: var(--s5);
        align-items: start;
      }
      .obp-theme-btn:hover { color: var(--text-hi); border-color: var(--text-hi); }
      .obp-product-btn:hover { color: var(--text-hi); }
      .obp-step:hover { color: var(--text-hi); background: var(--line); }
      .obp-input:focus { outline: none; border-color: var(--accent); }
      @media (max-width: 1100px) {
        #obp-bottom { grid-template-columns: minmax(0,1fr); }
        #obp-hero { grid-template-columns: minmax(0,1fr); gap: var(--s4); }
      }
      @media (max-width: 720px) {
        #obp-grid { grid-template-columns: minmax(0,1fr); }
        #obp-mid { order: 3; }
      }
    `}</style>
  );
}

// ─────────────────────────────── header ──────────────────────────────────

function Header(props: {
  product: Product; onProduct: (p: Product) => void;
  clock: string; theme: "dark" | "light"; onToggleTheme: () => void;
}): JSX.Element {
  return (
    <header
      style={{
        width: "100%",
        maxWidth: 1680,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--s4)",
        borderBottom: "1px solid var(--line)",
        paddingBottom: "var(--s3)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s4)", minWidth: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", border: "1px solid var(--line-2)" }}>
          {PRODUCTS.map((p, i) => {
            const selected = p === props.product;
            return (
              <button
                key={p}
                onClick={() => props.onProduct(p)}
                className="obp-product-btn"
                style={{
                  background: selected ? "var(--panel-2)" : "transparent",
                  color: selected ? "var(--text-hi)" : "var(--dim)",
                  fontWeight: selected ? 700 : 400,
                  border: "none",
                  borderLeft: i === 0 ? "none" : "1px solid var(--line-2)",
                  borderBottom: selected ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: "var(--t-num)",
                  letterSpacing: "0.04em",
                  padding: "4px 10px",
                }}
              >
                {p}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: "var(--t-label)", color: "var(--dim)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          Coinbase · level 2 · aggregated depth
        </span>
        <span style={{ fontSize: "var(--t-label)", color: "var(--dim-2)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          tick 0.01 · lot 0.00000001
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
        <span style={{ fontSize: "var(--t-label)", color: "var(--dim)", letterSpacing: "0.1em" }}>{props.clock}</span>
        <button
          className="obp-theme-btn"
          onClick={props.onToggleTheme}
          style={{
            background: "transparent",
            border: "1px solid var(--line-2)",
            color: "var(--dim)",
            fontSize: "var(--t-label)",
            letterSpacing: "0.12em",
            padding: "5px 10px",
            textTransform: "uppercase",
          }}
        >
          {props.theme === "dark" ? "light" : "dark"}
        </button>
      </div>
    </header>
  );
}

// ─────────────────────────── depth panels ────────────────────────────────

interface Row {
  key: number;
  price: string;
  size: string;
  cum: string;
  barPct: string;
  weight: 400 | 700;
  probeMark: string;
}

function BidPanel({ rows }: { rows: readonly Row[] }): JSX.Element {
  return (
    <section style={panelBox}>
      <div style={depthHeader}>
        <span style={{ textAlign: "left", color: "var(--bid)" }}>Bids</span>
        <span style={{ textAlign: "right" }}>size</span>
        <span style={{ textAlign: "right" }}>price</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
        {rows.map((row) => (
          <div key={row.key} style={depthRow}>
            <div style={{ ...depthBar, right: 0, background: "var(--bid-bar)", width: row.barPct }} />
            <span style={{ position: "relative", textAlign: "left", color: "var(--dim-2)", fontSize: "var(--t-body)" }}>{row.cum}</span>
            <span style={{ position: "relative", textAlign: "right", color: "var(--text)" }}>{row.size}</span>
            <span style={{ position: "relative", textAlign: "right", color: "var(--bid)", fontWeight: row.weight }}>{row.price}</span>
            <div style={{ position: "absolute", top: 0, bottom: 0, right: -4, width: 2, background: row.probeMark }} />
          </div>
        ))}
      </div>
    </section>
  );
}

function AskPanel({ rows }: { rows: readonly Row[] }): JSX.Element {
  return (
    <section style={panelBox}>
      <div style={depthHeader}>
        <span style={{ textAlign: "left" }}>price</span>
        <span style={{ textAlign: "left" }}>size</span>
        <span style={{ textAlign: "right", color: "var(--ask)" }}>Asks</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
        {rows.map((row) => (
          <div key={row.key} style={depthRow}>
            <div style={{ ...depthBar, left: 0, background: "var(--ask-bar)", width: row.barPct }} />
            <span style={{ position: "relative", textAlign: "left", color: "var(--ask)", fontWeight: row.weight }}>{row.price}</span>
            <span style={{ position: "relative", textAlign: "left", color: "var(--text)" }}>{row.size}</span>
            <span style={{ position: "relative", textAlign: "right", color: "var(--dim-2)", fontSize: "var(--t-body)" }}>{row.cum}</span>
            <div style={{ position: "absolute", top: 0, bottom: 0, left: -4, width: 2, background: row.probeMark }} />
          </div>
        ))}
      </div>
    </section>
  );
}

const panelBox: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  padding: "var(--s3)",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
};

const depthHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "var(--s2)",
  fontSize: "var(--t-label)",
  letterSpacing: "0.12em",
  color: "var(--dim)",
  textTransform: "uppercase",
  paddingBottom: 6,
  borderBottom: "1px solid var(--line)",
};

const depthRow: CSSProperties = {
  position: "relative",
  height: 24,
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "var(--s2)",
  alignItems: "center",
  fontSize: "var(--t-num)",
};

const depthBar: CSSProperties = {
  position: "absolute",
  top: 1,
  bottom: 1,
  transition: "width 190ms cubic-bezier(.2,.6,.3,1)",
};

// ─────────────────────────── metrics column ──────────────────────────────

interface View {
  bidRows: Row[];
  askRows: Row[];
  spreadUsd: string;
  spreadTicks: string;
  spreadBps: string;
  mid: string;
  micro: string;
  microDrift: string;
  imbBidPct: string;
  imbAskPct: string;
  imbSigned: string;
  imbBidWidth: string;
  bidDepthTotal: string;
  askDepthTotal: string;
  probePriceLabel: string;
  sizeLotsLabel: string;
  seqLabel: string;
  fill: FillRange | null;
}

function MetricsPanel({ view, imbalanceDepth, depth }: {
  view: View; imbalanceDepth: number; depth: number;
}): JSX.Element {
  return (
    <section
      id="obp-mid"
      style={{
        ...panelBox,
        gap: "var(--s4)",
      }}
    >
      <div>
        <div style={labelStyle}>Spread</div>
        <div style={{ fontSize: "var(--t-xl)", color: "var(--text-hi)", lineHeight: 1.15, marginTop: 2 }}>
          {view.spreadUsd}
        </div>
        <div style={{ fontSize: "var(--t-label)", color: "var(--dim)", letterSpacing: "0.08em" }}>
          {view.spreadTicks} · {view.spreadBps}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
        <div>
          <div style={labelStyle}>Mid</div>
          <div style={{ fontSize: "var(--t-lg)", color: "var(--text-hi)", lineHeight: 1.2 }}>{view.mid}</div>
        </div>
        <div>
          <div style={labelStyle}>Microprice</div>
          <div style={{ fontSize: "var(--t-lg)", color: "var(--text-hi)", lineHeight: 1.2 }}>{view.micro}</div>
          <div style={{ fontSize: "var(--t-label)", color: "var(--dim)" }}>{view.microDrift} vs mid</div>
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", ...labelStyle }}>
          <span>Imbalance</span>
          <span>{imbalanceDepth}L</span>
        </div>
        <div style={{ position: "relative", height: 8, marginTop: 6, background: "var(--panel-2)", border: "1px solid var(--line)" }}>
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0,
            background: "var(--bid)", opacity: 0.55,
            transition: "width 190ms cubic-bezier(.2,.6,.3,1)",
            width: view.imbBidWidth,
          }} />
          <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: "var(--line-2)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: "var(--t-num)" }}>
          <span style={{ color: "var(--bid)" }}>{view.imbBidPct}</span>
          <span style={{ color: "var(--text-hi)" }}>{view.imbSigned}</span>
          <span style={{ color: "var(--ask)" }}>{view.imbAskPct}</span>
        </div>
      </div>
      <div style={{
        borderTop: "1px solid var(--line)",
        paddingTop: "var(--s3)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: "var(--t-label)",
        color: "var(--dim)",
        letterSpacing: "0.06em",
      }}>
        <TotalRow label="BID DEPTH" value={view.bidDepthTotal} />
        <TotalRow label="ASK DEPTH" value={view.askDepthTotal} />
        <TotalRow label="LEVELS" value={`${depth} × 2`} />
      </div>
    </section>
  );
}

function TotalRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span>{label}</span>
      <span style={{ color: "var(--text)" }}>{value}</span>
    </div>
  );
}

const labelStyle: CSSProperties = {
  fontSize: "var(--t-label)",
  letterSpacing: "0.12em",
  color: "var(--dim)",
  textTransform: "uppercase",
};

// ──────────────────────────── probe panel ────────────────────────────────

function ProbePanel(props: {
  side: Side;
  onSide: (s: Side) => void;
  offset: number;
  onOffset: (updater: (o: number) => number) => void;
  probePriceLabel: string;
  sizeInput: string;
  onSizeInput: (v: string) => void;
  budgetInput: string;
  onBudgetInput: (v: string) => void;
  sizeLotsLabel: string;
}): JSX.Element {
  const isBid = props.side === Side.Bid;
  const offsetLabel = (isBid ? "−" : "+") + props.offset;

  return (
    <section style={{ ...panelBox, gap: "var(--s3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: "var(--t-label)", letterSpacing: "0.14em", color: "var(--text-hi)", textTransform: "uppercase" }}>
          Passive order probe
        </span>
        <span style={{ fontSize: "var(--t-micro)", letterSpacing: "0.1em", color: "var(--dim-2)", textTransform: "uppercase" }}>
          hypothetical · not sent
        </span>
      </div>

      <FieldGroup label="Side">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, border: "1px solid var(--line-2)" }}>
          <button
            onClick={() => props.onSide(Side.Bid)}
            style={sideButtonStyle(isBid, "bid")}
          >BID</button>
          <button
            onClick={() => props.onSide(Side.Ask)}
            style={{ ...sideButtonStyle(!isBid, "ask"), borderLeft: "1px solid var(--line-2)" }}
          >ASK</button>
        </div>
      </FieldGroup>

      <FieldGroup label="Offset from touch" hint="ticks">
        <div style={{ display: "grid", gridTemplateColumns: "34px 1fr 34px", border: "1px solid var(--line-2)" }}>
          <button
            className="obp-step"
            onClick={() => props.onOffset((o) => clamp(o - 1, 0, 40))}
            style={stepButtonStyle("right")}
          >−</button>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--s2)", padding: "7px 0" }}>
            <span style={{ fontSize: "var(--t-num)", color: "var(--text-hi)" }}>{offsetLabel}</span>
            <span style={{ fontSize: "var(--t-label)", color: "var(--dim)" }}>@ {props.probePriceLabel}</span>
          </div>
          <button
            className="obp-step"
            onClick={() => props.onOffset((o) => clamp(o + 1, 0, 40))}
            style={stepButtonStyle("left")}
          >+</button>
        </div>
      </FieldGroup>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s3)" }}>
        <FieldGroup label="Order size">
          <input
            className="obp-input"
            value={props.sizeInput}
            onChange={(e) => props.onSizeInput(e.target.value)}
            inputMode="decimal"
            style={textInputStyle}
          />
          <span style={{ fontSize: "var(--t-micro)", color: "var(--dim-2)", letterSpacing: "0.08em" }}>
            {props.sizeLotsLabel}
          </span>
        </FieldGroup>
        <FieldGroup label="Volume budget">
          <input
            className="obp-input"
            value={props.budgetInput}
            onChange={(e) => props.onBudgetInput(e.target.value)}
            inputMode="decimal"
            style={textInputStyle}
          />
          <span style={{ fontSize: "var(--t-micro)", color: "var(--dim-2)", letterSpacing: "0.08em" }}>
            traded through level, holding window
          </span>
        </FieldGroup>
      </div>
    </section>
  );
}

function FieldGroup({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", ...labelStyle }}>
        <span>{label}</span>
        {hint ? <span style={{ color: "var(--dim-2)" }}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function sideButtonStyle(selected: boolean, which: "bid" | "ask"): CSSProperties {
  const bg = selected ? (which === "bid" ? "var(--bid-bar)" : "var(--ask-bar)") : "transparent";
  const fg = selected ? (which === "bid" ? "var(--bid)" : "var(--ask)") : "var(--dim)";
  return {
    background: bg,
    color: fg,
    border: "none",
    padding: "7px 0",
    fontSize: "var(--t-body)",
    letterSpacing: "0.14em",
  };
}

function stepButtonStyle(divider: "left" | "right"): CSSProperties {
  return {
    background: "var(--panel-2)",
    border: "none",
    borderLeft: divider === "left" ? "1px solid var(--line-2)" : undefined,
    borderRight: divider === "right" ? "1px solid var(--line-2)" : undefined,
    color: "var(--text)",
    padding: "7px 0",
  };
}

const textInputStyle: CSSProperties = {
  background: "var(--panel-2)",
  border: "1px solid var(--line-2)",
  color: "var(--text-hi)",
  padding: "7px 8px",
  fontSize: "var(--t-num)",
  width: "100%",
};

// ─────────────────────────── hero (fill range) ────────────────────────────

function HeroPanel({ view }: { view: View }): JSX.Element {
  const fill = view.fill;
  const marketable = fill?.marketable ?? false;
  const low = fill ? clamp(fill.low * 100, 0, 100) : 0;
  const high = fill ? clamp(fill.high * 100, 0, 100) : 0;
  const width = Math.max(high - low, 0.4);
  const mid = fill ? clamp(fill.midpoint * 100, 0, 100) : 0;
  const splitVis = width >= 24;

  return (
    <section id="obp-hero" style={{ background: "var(--panel)", border: "1px solid var(--line)", padding: "var(--s4)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)", minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: "var(--t-label)", letterSpacing: "0.14em", color: "var(--text-hi)", textTransform: "uppercase" }}>
            Expected fill fraction
          </span>
          <span style={{
            fontSize: "var(--t-micro)",
            letterSpacing: "0.1em",
            color: marketable ? "var(--amber)" : "var(--dim-2)",
            textTransform: "uppercase",
          }}>
            {marketable ? "marketable — would cross" : "passive · resting"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--s3)" }}>
          <div style={{ fontSize: "var(--t-hero)", lineHeight: 0.9, color: "var(--text-hi)" }}>
            {fill ? pct(fill.midpoint) : "—"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingBottom: 4 }}>
            <span style={{ ...labelStyle, letterSpacing: "0.1em" }}>midpoint estimate</span>
            <span style={{ fontSize: "var(--t-body)", color: "var(--accent)" }}>
              range {fill ? pct(fill.low) : "—"} — {fill ? pct(fill.high) : "—"}
            </span>
          </div>
        </div>

        <div style={{ position: "relative", height: 86 }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: 26, height: 2, background: "var(--line)" }} />
          <div style={{
            position: "absolute", top: 14, height: 26,
            background: "var(--accent-soft)",
            borderLeft: "2px solid var(--accent)",
            borderRight: "2px solid var(--accent)",
            transition: "left 190ms ease, width 190ms ease",
            left: `${low.toFixed(2)}%`,
            width: `${width.toFixed(2)}%`,
          }} />
          <div style={{
            position: "absolute", top: 6, height: 42, width: 1,
            background: "var(--accent)",
            transition: "left 190ms ease",
            left: `${mid.toFixed(2)}%`,
          }} />
          {splitVis ? (
            <>
              <BracketLabel value={fill ? pct(fill.low) : "—"} pos={`${clamp(low, 6, 94).toFixed(2)}%`} />
              <BracketLabel value={fill ? pct(fill.high) : "—"} pos={`${clamp(low + width, 6, 94).toFixed(2)}%`} />
            </>
          ) : (
            <BracketLabel
              value={fill ? `${pct(fill.low)} — ${pct(fill.high)}` : "—"}
              pos={`${clamp(low + width / 2, 14, 86).toFixed(2)}%`}
            />
          )}
          <div style={{
            position: "absolute", left: 0, right: 0, bottom: 0,
            display: "flex", justifyContent: "space-between",
            fontSize: "var(--t-micro)", color: "var(--dim-2)", letterSpacing: "0.08em",
          }}>
            <span>0%</span><span>25</span><span>50</span><span>75</span><span>100%</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)", minWidth: 0 }}>
        <ModelTable fill={fill} />
        <div style={{ fontSize: "var(--t-micro)", lineHeight: 1.7, color: "var(--dim-2)", letterSpacing: "0.03em" }}>
          Bracket spans the pessimistic and optimistic queue models against the live level.
          Queue ahead is read from the book at the probe price on each update; the volume
          budget is the amount of size you expect to trade at your price or better during
          your holding window.
        </div>
      </div>
    </section>
  );
}

function BracketLabel({ value, pos }: { value: string; pos: string }): JSX.Element {
  return (
    <div style={{
      position: "absolute",
      top: 44,
      fontSize: "var(--t-label)",
      color: "var(--dim)",
      transform: "translateX(-50%)",
      whiteSpace: "nowrap",
      transition: "left 190ms ease",
      left: pos,
    }}>{value}</div>
  );
}

function ModelTable({ fill }: { fill: FillRange | null }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--line)" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1.5fr 68px 1fr 1fr",
        gap: "var(--s2)",
        padding: "8px 0 6px",
        fontSize: "var(--t-micro)",
        letterSpacing: "0.12em",
        color: "var(--dim)",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--line)",
      }}>
        <span>queue model</span>
        <span style={{ textAlign: "right" }}>fill</span>
        <span style={{ textAlign: "right" }}>queue ahead</span>
        <span style={{ textAlign: "right" }}>lots to fill</span>
      </div>
      {(fill?.perModel ?? []).map((m) => (
        <ModelRow key={m.model} m={m} />
      ))}
      {fill === null ? (
        <div style={{ padding: "18px 0", color: "var(--dim-2)", fontSize: "var(--t-body)" }}>
          waiting for book…
        </div>
      ) : null}
    </div>
  );
}

function ModelRow({ m }: { m: FillEstimate }): JSX.Element {
  const meta = MODEL_META[m.model] ?? { name: m.model, note: "" };
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1.5fr 68px 1fr 1fr",
      gap: "var(--s2)",
      alignItems: "center",
      padding: "9px 0",
      borderBottom: "1px solid var(--line)",
      fontSize: "var(--t-body)",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ color: "var(--text-hi)" }}>{meta.name}</span>
        <span style={{ fontSize: "var(--t-micro)", color: "var(--dim-2)", letterSpacing: "0.04em" }}>{meta.note}</span>
      </div>
      <div style={{ textAlign: "right", color: "var(--text-hi)", fontSize: "var(--t-num)" }}>{pct(m.fillFraction)}</div>
      <span style={{ textAlign: "right", color: "var(--text)" }}>{fmtSize(m.queueAhead, 3)}</span>
      <span style={{ textAlign: "right", color: "var(--dim)" }}>{Math.round(m.lotsNeededForFullFill).toLocaleString("en-US")}</span>
    </div>
  );
}

// ───────────────────────────── status strip ───────────────────────────────

function StatusStrip(props: {
  status: string; seq: string; gaps: number; msgs: number;
  mps: number; bookAge: string; errorMessage: string;
}): JSX.Element {
  const connected = props.status === "live";
  const statusColor = connected ? "var(--bid)" : "var(--amber)";
  const gapColor = props.gaps > 0 ? "var(--amber)" : "var(--text)";
  return (
    <footer style={{
      width: "100%",
      maxWidth: 1680,
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "var(--s5)",
      borderTop: "1px solid var(--line)",
      paddingTop: 10,
      fontSize: "var(--t-label)",
      letterSpacing: "0.1em",
      color: "var(--dim)",
      textTransform: "uppercase",
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 7, color: statusColor }}>
        <span style={{ width: 6, height: 6, background: statusColor, display: "inline-block" }} />
        {connected ? "connected" : props.status}
      </span>
      <span>seq <span style={{ color: "var(--text)" }}>{props.seq}</span></span>
      <span>gaps <span style={{ color: gapColor }}>{props.gaps}</span></span>
      <span>msgs <span style={{ color: "var(--text)" }}>{props.msgs.toLocaleString("en-US")}</span></span>
      <span><span style={{ color: "var(--text)" }}>{props.mps}</span> msg/s</span>
      <span>book age <span style={{ color: "var(--text)" }}>{props.bookAge}</span></span>
      {props.errorMessage ? (
        <span style={{ color: "var(--amber)" }}>{props.errorMessage}</span>
      ) : null}
    </footer>
  );
}

// ─────────────────────────── derived render values ────────────────────────

function derive(args: {
  state: FeedState | null;
  depth: number;
  imbalanceDepth: number;
  side: Side;
  offset: number;
  sizeInput: string;
  budgetInput: string;
  product: Product;
}): View {
  const empty: View = {
    bidRows: [], askRows: [],
    spreadUsd: "—", spreadTicks: "—", spreadBps: "—",
    mid: "—", micro: "—", microDrift: "—",
    imbBidPct: "—", imbAskPct: "—", imbSigned: "—", imbBidWidth: "0%",
    bidDepthTotal: "—", askDepthTotal: "—",
    probePriceLabel: "—", sizeLotsLabel: "—",
    seqLabel: "—",
    fill: null,
  };
  if (!args.state) return empty;

  const book = args.state.book;
  const bb = book.bestBid();
  const ba = book.bestAsk();
  if (bb === null || ba === null) return { ...empty, seqLabel: seqLabel(book.lastSequence()) };

  const bids = book.levels(Side.Bid, args.depth);
  const asks = book.levels(Side.Ask, args.depth);
  const maxSz = Math.max(1, ...bids.map((l) => l.size), ...asks.map((l) => l.size));

  const touch = args.side === Side.Bid ? bb : ba;
  const probePrice = args.side === Side.Bid ? touch - args.offset : touch + args.offset;

  const mkRows = (levels: readonly { price: number; size: number }[]): Row[] => {
    let cum = 0;
    return levels.map((l, i) => {
      cum += l.size;
      return {
        key: l.price,
        price: fmtPrice(l.price),
        size: fmtSize(l.size),
        cum: fmtSize(cum, 3),
        barPct: `${(100 * l.size / maxSz).toFixed(1)}%`,
        weight: (i === 0 ? 700 : 400) as 400 | 700,
        probeMark: l.price === probePrice ? "var(--accent)" : "transparent",
      };
    });
  };

  const bidRows = mkRows(bids);
  const askRows = mkRows(asks);

  const spreadTicks = ba - bb;
  const midTicks = (bb + ba) / 2;
  const microTicks = book.microprice();

  const bidSum = bids.slice(0, args.imbalanceDepth).reduce((a, l) => a + l.size, 0);
  const askSum = asks.slice(0, args.imbalanceDepth).reduce((a, l) => a + l.size, 0);
  const total = bidSum + askSum;
  const bidRatio = total > 0 ? bidSum / total : 0.5;
  const signed = total > 0 ? (bidSum - askSum) / total : 0;

  const sizeLots = toLots(args.sizeInput, 0.05);
  const budgetLots = toLots(args.budgetInput, 2);

  const fill = estimateFill(book, {
    side: args.side,
    price: probePrice,
    size: sizeLots,
    volumeBudget: budgetLots,
  });

  return {
    bidRows, askRows,
    spreadUsd: `$${BTC.fromTicks(spreadTicks).toFixed(2)}`,
    spreadTicks: `${spreadTicks} ${spreadTicks === 1 ? "tick" : "ticks"}`,
    spreadBps: `${(spreadTicks / midTicks * 1e4).toFixed(3)} bps`,
    mid: fmtPrice(midTicks),
    micro: microTicks === null ? "—"
      : BTC.fromTicks(microTicks).toLocaleString("en-US", {
          minimumFractionDigits: 4, maximumFractionDigits: 4,
        }),
    microDrift: microTicks === null ? "—"
      : (() => {
          const drift = BTC.fromTicks(microTicks - midTicks);
          return `${drift >= 0 ? "+" : ""}${drift.toFixed(4)}`;
        })(),
    imbBidPct: `${(bidRatio * 100).toFixed(1)}%`,
    imbAskPct: `${((1 - bidRatio) * 100).toFixed(1)}%`,
    imbSigned: `${signed >= 0 ? "+" : ""}${signed.toFixed(3)}`,
    imbBidWidth: `${(bidRatio * 100).toFixed(1)}%`,
    bidDepthTotal: fmtSize(bidSum, 3),
    askDepthTotal: fmtSize(askSum, 3),
    probePriceLabel: fmtPrice(probePrice),
    sizeLotsLabel: `${sizeLots.toLocaleString("en-US")} lots ${baseOf(args.product)}`,
    seqLabel: seqLabel(book.lastSequence()),
    fill,
  };
}

function seqLabel(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}
