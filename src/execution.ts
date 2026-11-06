// Paper execution only. This NEVER calls a real broker order endpoint.
// It simulates a fill in memory and returns a record for printing/reporting.
// No API keys are used here, no orders are sent anywhere, nothing is persisted.

import { OrderSide, PaperOrder, RiskDecision, Signal } from "./types.js";

export function executePaperOrder(signal: Signal, risk: RiskDecision): PaperOrder | null {
  if (signal.action === "HOLD" || risk.status !== "APPROVED") {
    return null;
  }
  const side: OrderSide = signal.action; // narrowed to "BUY" | "SELL" by the guard above

  return {
    side,
    symbol: signal.symbol,
    quantity: risk.quantity,
    price: signal.price,
    timestamp: signal.timestamp,
    simulated: true,
  };
}
