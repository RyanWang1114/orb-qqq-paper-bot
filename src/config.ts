// Centralized runtime configuration — the ONE place to change symbol, quantity,
// and max position. Values are real inputs (env vars with safe defaults), not
// duplicated/hardcoded separately across bot.ts and replay.ts like before.
//
// To experiment: copy .env.example to .env and edit BOT_SYMBOL / BOT_QUANTITY /
// BOT_MAX_POSITION / BOT_REPLAY_DAYS there. No code changes needed for those.
//
// TIMEFRAME is deliberately NOT an env var. strategy.ts's opening-range window and
// forced-end-of-day-close logic (RANGE_END_MIN, LAST_BAR_START_MIN, etc.) are
// written assuming 15-minute bars. Changing the bar size without also updating
// those constants would silently break the forced EOD close (a real correctness
// bug, not a style choice) — so changing timeframe is a deliberate code edit in
// strategy.ts, not a casual env flip. See README.md "Configuration".
//
// This module is imported by every command path (scan, replay:raw, replay:memory
// all go through bot.ts/replay.ts, which both import this file), so the
// accidental-live-trading guardrail below runs no matter which command is used.

import dotenv from "dotenv";
import { RiskConfig } from "./types.js";

dotenv.config(); // local .env in this project, if present

// --- Accidental-live-trading guardrail --------------------------------------
// There is no live order-placing code anywhere in this project — execution.ts
// only ever simulates a fill (PaperOrder.simulated is always literal `true`, and
// no broker order endpoint is called from any file). This check exists so that if
// a live path is ever added later, an operator would have to both add that code
// AND set this flag — and until that code exists, setting the flag fails loudly
// right now instead of quietly doing nothing.
if (process.env.ALLOW_LIVE_TRADING === "true") {
  throw new Error(
    "ALLOW_LIVE_TRADING=true is set, but this project has no live order-placing code " +
      "path (execution.ts only ever simulates paper fills). Refusing to start. Remove " +
      "ALLOW_LIVE_TRADING from your environment/.env — it is not supported here."
  );
}

function requirePositiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}="${raw}" in your environment/.env — must be a positive number.`);
  }
  return n;
}

/** Ticker to trade. Change via BOT_SYMBOL in .env. */
export const SYMBOL = process.env.BOT_SYMBOL?.trim() || "QQQ";

/** Bar size. Fixed — see file-level comment above before changing this. */
export const TIMEFRAME = "15Min";

/** Shares per signal. Change via BOT_QUANTITY in .env. */
export const QUANTITY = requirePositiveNumber("BOT_QUANTITY", process.env.BOT_QUANTITY, 10);

/** Hard ceiling on quantity — orders above this are skipped by risk.ts. Change via BOT_MAX_POSITION in .env. */
export const MAX_POSITION = requirePositiveNumber("BOT_MAX_POSITION", process.env.BOT_MAX_POSITION, 20);

/** Lookback window (days) for replay:raw / replay:memory. Change via BOT_REPLAY_DAYS in .env. */
export const REPLAY_DAYS = requirePositiveNumber("BOT_REPLAY_DAYS", process.env.BOT_REPLAY_DAYS, 60);

if (QUANTITY > MAX_POSITION) {
  // Not fatal — risk.ts already skips every order in this case and explains why in
  // the log — but surfacing it here too catches an obviously-wrong config early.
  console.warn(
    `Warning: BOT_QUANTITY (${QUANTITY}) exceeds BOT_MAX_POSITION (${MAX_POSITION}). ` +
      `Every signal will be skipped by the risk check until this is fixed in .env.`
  );
}

export const riskConfig: RiskConfig = { quantity: QUANTITY, maxPosition: MAX_POSITION };
