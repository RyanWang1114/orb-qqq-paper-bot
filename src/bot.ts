// Orchestrator for a single live check (`npm run scan`).
// market -> strategy -> risk -> execution, in that order, exactly as specified.
// Paper/local only. No broker order endpoint is ever called.

import { getRecentBars } from "./market.js";
import { evaluateBar, initialState, rangeSizePct } from "./strategy.js";
import { evaluateRisk } from "./risk.js";
import { executePaperOrder } from "./execution.js";
import { appendLedgerRow, readLedger } from "./memory.js";
import { checkMemory } from "./adaptiveFilter.js";
import { SYMBOL, TIMEFRAME, riskConfig } from "./config.js";

export async function scan(): Promise<void> {
  console.log(`ORB paper bot — scan (${SYMBOL}, ${TIMEFRAME}, Alpaca IEX feed, real market data)`);
  console.log(`Risk config: quantity=${riskConfig.quantity}, maxPosition=${riskConfig.maxPosition}\n`);

  // Enough bars to cover from today's open through now, even on a slow-loading first bar.
  const bars = await getRecentBars(SYMBOL, TIMEFRAME, 40);

  if (bars.length === 0) {
    console.log("No bars returned — market may be closed, or the symbol/timeframe is unavailable right now.");
    return;
  }

  // Replay only today's bars (by ET date) to rebuild the opening range / position state
  // up to the latest bar, then report the signal for that latest bar.
  let state = initialState();
  let lastSignal;
  let rangeHighAtEntry: number | null = null;
  let rangeLowAtEntry: number | null = null;
  let entryPriceBeforeBar: number | null = null;
  for (const bar of bars) {
    rangeHighAtEntry = state.rangeHigh;
    rangeLowAtEntry = state.rangeLow;
    entryPriceBeforeBar = state.entryPrice;
    const result = evaluateBar(bar, state, SYMBOL);
    state = result.state;
    lastSignal = result.signal;
  }

  const latest = bars[bars.length - 1];
  console.log(`Latest bar: ${latest.timestamp}  O=${latest.open} H=${latest.high} L=${latest.low} C=${latest.close} V=${latest.volume}`);
  console.log(`Signal: ${lastSignal!.action} — ${lastSignal!.reason}`);

  if (lastSignal!.action === "BUY" && rangeHighAtEntry !== null && rangeLowAtEntry !== null) {
    const setupRangePct = rangeSizePct(rangeHighAtEntry, rangeLowAtEntry);
    const ledger = readLedger();
    const memCheck = checkMemory(SYMBOL, setupRangePct, ledger);
    console.log(`Memory: ${memCheck.skip ? "SKIP" : "no match"} — ${memCheck.reason}`);

    if (memCheck.skip) {
      appendLedgerRow({
        timestamp: lastSignal!.timestamp,
        symbol: SYMBOL,
        action: "SKIP",
        price: lastSignal!.price,
        quantity: 0,
        reason: memCheck.reason,
        mode: "memory",
        outcome: "SKIPPED",
        pnl: null,
      });
      console.log("No paper order placed (memory match — skipped to avoid repeating a known bad trade).");
      console.log(
        "\nNote: the replay-only 25% max-drawdown check is NOT evaluated in scan mode " +
          "(it needs trade history built by replay:memory/replay:raw)."
      );
      return;
    }
  }

  const risk = evaluateRisk(lastSignal!, riskConfig);
  console.log(`Risk: ${risk.status} — ${risk.reason}`);

  const order = executePaperOrder(lastSignal!, risk);
  if (order) {
    console.log(
      `Paper order (SIMULATED — not sent to any broker or live endpoint): ${order.side} ${order.quantity} ${order.symbol} @ ${order.price}`
    );

    let outcome: "OPEN" | "WIN" | "LOSS" = "OPEN";
    let pnl: number | null = null;
    let reason = lastSignal!.reason;

    if (order.side === "SELL" && entryPriceBeforeBar !== null) {
      // Real entry price seen earlier in this same today's-bars replay — not persisted
      // across separate scan runs, so this only resolves win/loss when the entry and
      // exit both happened within the bars this single run fetched.
      pnl = (order.price - entryPriceBeforeBar) * order.quantity;
      outcome = pnl > 0 ? "WIN" : "LOSS";
      if (rangeHighAtEntry !== null && rangeLowAtEntry !== null) {
        reason = `${reason} [entry range ${rangeSizePct(rangeHighAtEntry, rangeLowAtEntry).toFixed(2)}%]`;
      }
    } else if (order.side === "SELL") {
      // Entry happened before this run's fetched window (e.g. bot restarted mid-day) —
      // real exit price is still recorded, but pnl can't be honestly computed here.
      reason = `${reason} (entry not observed in this run — pnl not computed)`;
    }

    appendLedgerRow({
      timestamp: order.timestamp,
      symbol: SYMBOL,
      action: order.side,
      price: order.price,
      quantity: order.quantity,
      reason,
      mode: "memory",
      outcome,
      pnl,
    });
  } else {
    console.log("No paper order placed.");
  }

  console.log(
    "\nNote: the replay-only 25% max-drawdown check is NOT evaluated in scan mode " +
      "(it needs trade history built by replay:memory/replay:raw)."
  );
}
