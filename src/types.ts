// Shared types for the ORB paper-trading bot.
// This first version has no memory system: nothing here is persisted to disk.

export interface Candle {
  timestamp: string; // ISO 8601, UTC, as returned by Alpaca
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalAction = "BUY" | "SELL" | "HOLD";

export interface Signal {
  action: SignalAction;
  symbol: string;
  price: number;
  timestamp: string;
  reason: string; // plain-English explanation, required for every decision
}

export interface StrategyState {
  dateKey: string | null; // "YYYY-MM-DD" in America/New_York, used to detect a new trading day
  rangeHigh: number | null;
  rangeLow: number | null;
  inPosition: boolean;
  tradedToday: boolean;
  entryPrice: number | null;
}

export interface RiskConfig {
  quantity: number; // shares to trade per signal
  maxPosition: number; // hard ceiling on quantity
}

export type RiskStatus = "APPROVED" | "SKIPPED";

export interface RiskDecision {
  status: RiskStatus;
  quantity: number;
  reason: string; // plain-English explanation, required for every decision
}

export type OrderSide = "BUY" | "SELL";

export interface PaperOrder {
  side: OrderSide;
  symbol: string;
  quantity: number;
  price: number;
  timestamp: string;
  simulated: true; // always true in this version — never a real broker order
}

// --- Memory system (real outcomes only — see memory.ts / adaptiveFilter.ts) ---

export type ReplayMode = "raw" | "memory";
export type LedgerAction = "BUY" | "SELL" | "SKIP";
export type LedgerOutcome = "OPEN" | "WIN" | "LOSS" | "SKIPPED";

export interface LedgerRow {
  timestamp: string;
  symbol: string;
  action: LedgerAction;
  price: number;
  quantity: number;
  reason: string;
  mode: ReplayMode;
  outcome: LedgerOutcome;
  pnl: number | null; // only populated on SELL rows that close a trade
}

export interface MemoryCheckResult {
  skip: boolean;
  reason: string;
}
