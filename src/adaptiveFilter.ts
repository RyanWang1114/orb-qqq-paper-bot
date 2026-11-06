// Decides whether a real BUY signal matches a real, REPEATED prior loss pattern for
// this symbol. Every input here comes from data/ledger.csv (real recorded trades) —
// this file never fabricates a threshold or a loss. It deliberately mirrors the exact
// statistical test used to write learnings.md (median-range clustering, >= 2 real
// losses) rather than a looser "narrower than the worst loss ever" rule — an earlier
// version of this check used that looser rule and skipped nearly every setup, which
// wasn't a meaningful match, just noise.

import { LedgerRow, MemoryCheckResult } from "./types.js";

// Reason strings for SELL rows embed the real opening-range size at entry, e.g.
// "...breakdown exit. [entry range 0.68%]" — written by replay.ts/bot.ts, read back here.
const RANGE_TAG = /\[entry range ([\d.]+)%\]/;

function extractRangePct(reason: string): number | null {
  const match = reason.match(RANGE_TAG);
  return match ? Number(match[1]) : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

interface RangedTrade {
  row: LedgerRow;
  rangePct: number;
}

function closedTradesWithRange(symbol: string, ledger: LedgerRow[]): RangedTrade[] {
  return ledger
    .filter((r) => r.symbol === symbol && r.action === "SELL" && (r.outcome === "WIN" || r.outcome === "LOSS"))
    .map((row) => ({ row, rangePct: extractRangePct(row.reason) }))
    .filter((x): x is RangedTrade => x.rangePct !== null);
}

const MIN_TRADES_FOR_PATTERN = 5;
const MIN_REPEATED_LOSSES = 2;

/**
 * Checks a live BUY setup (current opening-range size, in %) against a real, repeated
 * loss pattern for the same symbol: at least MIN_REPEATED_LOSSES real losses clustered
 * below the median opening-range size across all of this symbol's real recorded trades
 * — the same test that produces a learnings.md entry. A single anecdotal past loss does
 * NOT trigger a skip; it takes real repetition.
 */
export function checkMemory(symbol: string, currentRangePct: number, ledger: LedgerRow[]): MemoryCheckResult {
  const trades = closedTradesWithRange(symbol, ledger);
  const losses = trades.filter((t) => t.row.outcome === "LOSS");

  if (losses.length === 0) {
    return {
      skip: false,
      reason: `No simulated prior loss recorded for ${symbol} yet — nothing to match against. Run npm run replay:raw first to build simulated trade history from market data.`,
    };
  }

  if (trades.length < MIN_TRADES_FOR_PATTERN) {
    return {
      skip: false,
      reason: `Only ${trades.length} simulated closed trade(s) recorded for ${symbol} — not enough setups yet to detect a repeated pattern. Keep paper testing.`,
    };
  }

  const med = median(trades.map((t) => t.rangePct));
  const narrowLosses = losses.filter((t) => t.rangePct < med);

  if (narrowLosses.length < MIN_REPEATED_LOSSES) {
    return {
      skip: false,
      reason: `${losses.length} simulated loss(es) recorded for ${symbol}, but no repeated narrow-range pattern (fewer than ${MIN_REPEATED_LOSSES} clustered below the median range of ${med.toFixed(
        2
      )}%). No repeated losses to warn about yet.`,
    };
  }

  if (currentRangePct >= med) {
    return {
      skip: false,
      reason: `${symbol} has a documented narrow-range loss pattern (${narrowLosses.length} simulated losses below median range ${med.toFixed(
        2
      )}%), but this setup's range (${currentRangePct.toFixed(2)}%) is at or above that threshold — no match.`,
    };
  }

  const example = narrowLosses.reduce((worst, t) => (t.rangePct > worst.rangePct ? t : worst));
  return {
    skip: true,
    reason:
      `${symbol} lost on a similar setup in the simulation: ${narrowLosses.length} simulated losses clustered below the median ` +
      `opening-range size (${med.toFixed(2)}%), e.g. ${example.row.timestamp} (range ${example.rangePct.toFixed(
        2
      )}%, PnL ${example.row.pnl?.toFixed(2)}). This setup's range (${currentRangePct.toFixed(
        2
      )}%) matches that same narrow bucket — skipping to avoid repeating a known bad trade.`,
  };
}
