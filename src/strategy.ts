// Opening Range Breakout strategy — see README.md for the implemented rules.
//
// Setup: opening range = high/low of the first 30 minutes (9:30-10:00 AM ET).
// Entry: after 10:00 AM ET, if flat and a 15-min bar CLOSES above the opening range high -> BUY.
//        Confirmation is on bar close, not intrabar. One entry per day, no re-entry.
// Exit:  a 15-min bar CLOSES below the opening range low -> SELL, OR
//        the last bar of the regular session -> forced SELL (no overnight hold).
// No additional stop-loss or take-profit. Long only.

import { Candle, Signal, StrategyState } from "./types.js";

const TIMEZONE = "America/New_York";

const RANGE_START_MIN = 9 * 60 + 30; // 09:30
const RANGE_END_MIN = 10 * 60; // 10:00
const SESSION_END_MIN = 16 * 60; // 16:00
const LAST_BAR_START_MIN = 15 * 60 + 45; // 15:45 (bar spans 15:45-16:00, closes at market close)

function getETParts(isoTimestamp: string): { minutesOfDay: number; dateKey: string } {
  const date = new Date(isoTimestamp);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;

  const hour = parseInt(map.hour, 10) % 24; // "24" at midnight boundary -> 0
  const minute = parseInt(map.minute, 10);

  return {
    minutesOfDay: hour * 60 + minute,
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

/** Opening range width as a percentage of the range low — shared by replay/memory code. */
export function rangeSizePct(rangeHigh: number, rangeLow: number): number {
  return ((rangeHigh - rangeLow) / rangeLow) * 100;
}

export function initialState(): StrategyState {
  return {
    dateKey: null,
    rangeHigh: null,
    rangeLow: null,
    inPosition: false,
    tradedToday: false,
    entryPrice: null,
  };
}

export interface EvalResult {
  signal: Signal;
  state: StrategyState;
}

export function evaluateBar(candle: Candle, prevState: StrategyState, symbol: string): EvalResult {
  const { minutesOfDay, dateKey } = getETParts(candle.timestamp);
  let state: StrategyState = { ...prevState };

  if (state.dateKey !== dateKey) {
    // New trading day: reset the range and the daily one-trade limit.
    // Position/entryPrice carry over only in the (should-never-happen) case a position
    // survived past the forced EOD close; in normal operation this is always flat here.
    state = {
      dateKey,
      rangeHigh: null,
      rangeLow: null,
      inPosition: state.inPosition,
      tradedToday: false,
      entryPrice: state.entryPrice,
    };
  }

  const inOpenRange = minutesOfDay >= RANGE_START_MIN && minutesOfDay < RANGE_END_MIN;
  const inEntryWindow = minutesOfDay >= RANGE_END_MIN && minutesOfDay < SESSION_END_MIN;
  const isLastBar = minutesOfDay === LAST_BAR_START_MIN;

  if (inOpenRange) {
    state.rangeHigh = state.rangeHigh === null ? candle.high : Math.max(state.rangeHigh, candle.high);
    state.rangeLow = state.rangeLow === null ? candle.low : Math.min(state.rangeLow, candle.low);
  }

  const rangeReady = state.rangeHigh !== null && state.rangeLow !== null;

  let signal: Signal;

  if (!state.inPosition) {
    if (inEntryWindow && rangeReady && !state.tradedToday && candle.close > state.rangeHigh!) {
      signal = {
        action: "BUY",
        symbol,
        price: candle.close,
        timestamp: candle.timestamp,
        reason: `Bar closed at ${candle.close.toFixed(2)}, above the opening range high of ${state.rangeHigh!.toFixed(2)} — breakout confirmed on bar close.`,
      };
      state.inPosition = true;
      state.tradedToday = true;
      state.entryPrice = candle.close;
    } else {
      let reason: string;
      if (!rangeReady) {
        reason = "Opening range not yet established (before 10:00 AM ET or insufficient bars today).";
      } else if (!inEntryWindow) {
        reason = "Outside the entry window (before 10:00 AM ET or after the regular session close).";
      } else if (state.tradedToday) {
        reason = "Already traded once today — no re-entry, per the one-trade-per-day rule.";
      } else {
        reason = `Bar closed at ${candle.close.toFixed(2)}, still below/at the opening range high of ${state.rangeHigh!.toFixed(2)} — no breakout yet.`;
      }
      signal = { action: "HOLD", symbol, price: candle.close, timestamp: candle.timestamp, reason };
    }
  } else {
    const brokeDown = rangeReady && candle.close < state.rangeLow!;
    if (brokeDown || isLastBar) {
      signal = {
        action: "SELL",
        symbol,
        price: candle.close,
        timestamp: candle.timestamp,
        reason: brokeDown
          ? `Bar closed at ${candle.close.toFixed(2)}, below the opening range low of ${state.rangeLow!.toFixed(2)} — breakdown exit.`
          : "Last bar of the regular session — forced end-of-day close, no overnight hold.",
      };
      state.inPosition = false;
      state.entryPrice = null;
    } else {
      signal = {
        action: "HOLD",
        symbol,
        price: candle.close,
        timestamp: candle.timestamp,
        reason: `In position since ${state.entryPrice?.toFixed(2)} — waiting for a close below the range low (${state.rangeLow!.toFixed(2)}) or the forced end-of-day close.`,
      };
    }
  }

  return { signal, state };
}
