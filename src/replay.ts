// `npm run replay:raw`    — honest baseline backtest over real historical Alpaca bars.
//                            Ignores memory entirely, exactly as before. Still writes real
//                            outcomes to data/ledger.csv (mode="raw") and, only if a real
//                            repeated-loss pattern is found, updates data/learnings.md.
// `npm run replay:memory` — same real backtest, but before each BUY it reads real ledger
//                            history and asks adaptiveFilter whether this setup has lost
//                            before. Only skips on a real prior warning.
//
// No synthetic/fixture candles, no fabricated trades, no seeded losses in either path.

import { getBarsRange } from "./market.js";
import { evaluateBar, initialState, rangeSizePct } from "./strategy.js";
import { evaluateRisk } from "./risk.js";
import { executePaperOrder } from "./execution.js";
import { appendLedgerRow, readLedger, upsertLearning } from "./memory.js";
import { checkMemory } from "./adaptiveFilter.js";
import { LedgerRow, ReplayMode } from "./types.js";
import { SYMBOL, TIMEFRAME, riskConfig, REPLAY_DAYS } from "./config.js";

const LOOKBACK_DAYS = REPLAY_DAYS;
const START_EQUITY = 100_000; // reporting only — not a real account, not persisted
const KILL_SWITCH_DRAWDOWN_PCT = 25;

interface TradeRecord {
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  rangeSizePct: number;
  skippedByMemory?: boolean;
}

async function loadBars() {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const bars = await getBarsRange(SYMBOL, TIMEFRAME, start.toISOString(), end.toISOString());
  return { bars, start, end };
}

async function runReplay(mode: ReplayMode): Promise<{ trades: TradeRecord[]; skips: number; maxDrawdownPct: number; killSwitchTripped: boolean }> {
  const { bars } = await loadBars();

  let state = initialState();
  const trades: TradeRecord[] = [];
  let skips = 0;
  let openEntry: { time: string; price: number; rangeHigh: number; rangeLow: number } | null = null;
  let equity = START_EQUITY;
  let peakEquity = equity;
  let maxDrawdownPct = 0;
  let killSwitchTripped = false;

  // In-memory copy of real ledger history, grown as this run produces new real rows,
  // so a loss discovered earlier in this same replay can also be matched later in it.
  const ledgerSoFar: LedgerRow[] = mode === "memory" ? readLedger() : [];

  for (const bar of bars) {
    const wasInPosition = state.inPosition;
    const rangeHighAtEntry = state.rangeHigh;
    const rangeLowAtEntry = state.rangeLow;

    const { signal, state: nextState } = evaluateBar(bar, state, SYMBOL);
    state = nextState;

    if (signal.action === "BUY" && !wasInPosition) {
      const setupRangePct =
        rangeHighAtEntry !== null && rangeLowAtEntry !== null ? rangeSizePct(rangeHighAtEntry, rangeLowAtEntry) : null;

      if (mode === "memory" && setupRangePct !== null) {
        const memCheck = checkMemory(SYMBOL, setupRangePct, ledgerSoFar);
        if (memCheck.skip) {
          skips++;
          const skipRow: LedgerRow = {
            timestamp: signal.timestamp,
            symbol: SYMBOL,
            action: "SKIP",
            price: signal.price,
            quantity: 0,
            reason: memCheck.reason,
            mode,
            outcome: "SKIPPED",
            pnl: null,
          };
          appendLedgerRow(skipRow);
          ledgerSoFar.push(skipRow);
          console.log(`  [SKIP] ${signal.timestamp} — ${memCheck.reason}`);

          // Correct state: no real position was entered, but the strategy's one-shot-per-day
          // signal still fired, so the day is used up (matches the raw strategy's daily limit).
          state = { ...state, inPosition: false, entryPrice: null };
          continue;
        }
      }

      const risk = killSwitchTripped
        ? { status: "SKIPPED" as const, quantity: 0, reason: "Kill-switch tripped (simulated drawdown >= 25%) — no new entries for the rest of this replay." }
        : evaluateRisk(signal, riskConfig);
      const order = executePaperOrder(signal, risk);
      if (order) {
        openEntry = { time: order.timestamp, price: order.price, rangeHigh: rangeHighAtEntry!, rangeLow: rangeLowAtEntry! };
        appendLedgerRow({
          timestamp: order.timestamp,
          symbol: SYMBOL,
          action: "BUY",
          price: order.price,
          quantity: order.quantity,
          reason: signal.reason,
          mode,
          outcome: "OPEN",
          pnl: null,
        });
      }
    } else if (signal.action === "SELL" && wasInPosition && openEntry) {
      const risk = { status: "APPROVED" as const, quantity: riskConfig.quantity, reason: "Exit signal — closing existing paper position." };
      const order = executePaperOrder(signal, risk);
      if (order) {
        const pnl = (order.price - openEntry.price) * order.quantity;
        const pnlPct = ((order.price - openEntry.price) / openEntry.price) * 100;
        const entryRangePct = rangeSizePct(openEntry.rangeHigh, openEntry.rangeLow);

        trades.push({
          entryTime: openEntry.time,
          entryPrice: openEntry.price,
          exitTime: order.timestamp,
          exitPrice: order.price,
          quantity: order.quantity,
          pnl,
          pnlPct,
          exitReason: signal.reason,
          rangeSizePct: entryRangePct,
        });

        const ledgerRow: LedgerRow = {
          timestamp: order.timestamp,
          symbol: SYMBOL,
          action: "SELL",
          price: order.price,
          quantity: order.quantity,
          reason: `${signal.reason} [entry range ${entryRangePct.toFixed(2)}%]`,
          mode,
          outcome: pnl > 0 ? "WIN" : "LOSS",
          pnl,
        };
        appendLedgerRow(ledgerRow);
        ledgerSoFar.push(ledgerRow);

        equity += pnl;
        peakEquity = Math.max(peakEquity, equity);
        const drawdownPct = ((peakEquity - equity) / peakEquity) * 100;
        maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
        if (drawdownPct >= KILL_SWITCH_DRAWDOWN_PCT) killSwitchTripped = true;

        openEntry = null;
      }
    }
  }

  return { trades, skips, maxDrawdownPct, killSwitchTripped };
}

export async function replayRaw(): Promise<void> {
  const { start, end } = await loadBars();
  console.log(`ORB paper bot — replay:raw (${SYMBOL}, ${TIMEFRAME}, Alpaca IEX feed, real historical candles)`);
  console.log(`Lookback: ${start.toISOString()} to ${end.toISOString()} (${LOOKBACK_DAYS} days)`);
  console.log(`Risk config: quantity=${riskConfig.quantity}, maxPosition=${riskConfig.maxPosition}`);
  console.log(`Memory: IGNORED in this path — replay:raw is the honest, unfiltered baseline.\n`);

  const { trades, maxDrawdownPct, killSwitchTripped } = await runReplay("raw");

  if (trades.length === 0) {
    console.log("No completed trades in this lookback window — nothing to replay or record.\n");
    return;
  }

  console.log(`Replayed the strategy bar-by-bar. Simulated trades using market data recorded to data/ledger.csv (mode=raw).\n`);
  printTradeTable(trades);
  printSummary(trades, maxDrawdownPct, killSwitchTripped);
  maybeWriteLearning(trades, start, end);

  console.log(
    "\nNote: replay:raw applies no memory filtering. It appended these simulated outcomes to data/ledger.csv, " +
      "and may have updated data/learnings.md if a repeated-loss pattern was found in the simulation (see above)."
  );
}

export async function replayMemory(): Promise<void> {
  const { start, end } = await loadBars();
  const priorLedger = readLedger();
  const priorLosses = priorLedger.filter((r) => r.action === "SELL" && r.outcome === "LOSS" && r.symbol === SYMBOL);

  console.log(`ORB paper bot — replay:memory (${SYMBOL}, ${TIMEFRAME}, Alpaca IEX feed, real historical candles)`);
  console.log(`Lookback: ${start.toISOString()} to ${end.toISOString()} (${LOOKBACK_DAYS} days)`);
  console.log(`Risk config: quantity=${riskConfig.quantity}, maxPosition=${riskConfig.maxPosition}`);

  if (priorLosses.length === 0) {
    console.log(
      `Memory: EMPTY — no simulated prior loss recorded for ${SYMBOL} in data/ledger.csv yet.\n` +
        `Run "npm run replay:raw" first to build simulated trade history from market data before memory filtering has anything to act on.\n` +
        `Proceeding anyway as an unfiltered run (tagged mode=memory) — keep paper testing.\n`
    );
  } else {
    console.log(`Memory: ${priorLosses.length} recorded simulated loss(es) for ${SYMBOL} loaded from data/ledger.csv.\n`);
  }

  const { trades, skips, maxDrawdownPct, killSwitchTripped } = await runReplay("memory");

  console.log(`\nMemory-filtered skips this run: ${skips}\n`);

  if (trades.length === 0 && skips === 0) {
    console.log("No completed trades and no skips in this lookback window — nothing to compare.\n");
    return;
  }

  printTradeTable(trades);
  printSummary(trades, maxDrawdownPct, killSwitchTripped);

  console.log(
    "\nNote: replay:memory only skips a BUY when a recorded simulated loss for this symbol matches the current " +
      "setup (see adaptiveFilter.ts). Otherwise it HOLDs/trades exactly like replay:raw. All rows — trades " +
      "and skips — were appended to data/ledger.csv with mode=memory."
  );
}

function printTradeTable(trades: TradeRecord[]): void {
  if (trades.length === 0) {
    console.log("No completed trades in this lookback window.\n");
    return;
  }

  console.log("Trade-by-trade results:");
  console.log(
    "#   Entry Time (UTC)         Entry $   Exit Time (UTC)          Exit $    Qty   PnL $      PnL %    Range %   Exit Reason"
  );
  trades.forEach((t, i) => {
    console.log(
      `${String(i + 1).padEnd(3)} ${t.entryTime.padEnd(25)} ${t.entryPrice.toFixed(2).padStart(8)}  ${t.exitTime.padEnd(25)} ${t.exitPrice
        .toFixed(2)
        .padStart(8)}  ${String(t.quantity).padStart(4)}  ${t.pnl.toFixed(2).padStart(9)}  ${t.pnlPct
        .toFixed(2)
        .padStart(6)}%  ${t.rangeSizePct.toFixed(2).padStart(6)}%   ${t.exitReason}`
    );
  });
  console.log("");
}

function printSummary(trades: TradeRecord[], maxDrawdownPct: number, killSwitchTripped: boolean): void {
  console.log("Summary metrics:");
  if (trades.length === 0) {
    console.log("  No trades — no metrics to summarize.");
    return;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  console.log(`  Total trades: ${trades.length}`);
  console.log(`  Win rate: ${((wins.length / trades.length) * 100).toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`  Total PnL: $${totalPnl.toFixed(2)} (${((totalPnl / START_EQUITY) * 100).toFixed(2)}% of starting paper equity)`);
  console.log(`  Profit factor: ${profitFactor === Infinity ? "∞ (no losing trades)" : profitFactor.toFixed(3)}`);
  console.log(`  Max drawdown (simulated, this run only): ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`  25% kill-switch tripped during this replay: ${killSwitchTripped ? "YES" : "no"}`);
  console.log(`  Avg win: ${avgWinPct.toFixed(2)}%   Avg loss: ${avgLossPct.toFixed(2)}%`);
}

/**
 * Only writes/updates a learnings.md section when a REAL repeated-loss pattern is found
 * (>= 5 trades, >= 2 losses, >= 2 of them clustered below the median opening-range size —
 * the same descriptive test the raw baseline already used to flag this on-screen). If the
 * real data doesn't show this pattern, nothing is written — no seeded lesson.
 */
function maybeWriteLearning(trades: TradeRecord[], start: Date, end: Date): void {
  if (trades.length < 5) return;
  const losses = trades.filter((t) => t.pnl <= 0);
  if (losses.length < 2) return;

  const sortedRanges = trades.map((t) => t.rangeSizePct).sort((a, b) => a - b);
  const median = sortedRanges[Math.floor(sortedRanges.length / 2)];
  const narrowRangeLosses = losses.filter((t) => t.rangeSizePct < median);
  if (narrowRangeLosses.length < 2) return;

  const evidence = narrowRangeLosses
    .map((t) => `- ${t.entryTime}: range ${t.rangeSizePct.toFixed(2)}%, PnL ${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(2)}%)`)
    .join("\n");

  const body =
    `${narrowRangeLosses.length} of ${losses.length} simulated losing trades using market data (${LOOKBACK_DAYS}-day replay, ` +
    `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}) occurred when the opening range ` +
    `was below the median size (${median.toFixed(2)}%). Simulated losing entries in this narrow-range bucket:\n\n` +
    `${evidence}\n\n` +
    `Lesson: treat ${SYMBOL} opening-range breakouts on below-median-range days as a setup that has failed before. ` +
    `This is a descriptive observation from simulated trades using market data — not a guarantee it will keep happening.`;

  upsertLearning(`${SYMBOL} — narrow opening range`, body);
  console.log(
    `\nlearnings.md updated: found a repeated-loss pattern in simulated trades (${narrowRangeLosses.length} narrow-range losses) — see data/learnings.md.`
  );
}
