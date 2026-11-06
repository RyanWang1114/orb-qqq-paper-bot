// Fixed share quantity capped by a configurable per-signal ceiling.
// Replay separately evaluates a realized-drawdown limit within one simulated
// run. Scan does not evaluate drawdown, and this module does not read account
// equity or size positions as a percentage of equity.

import { RiskConfig, RiskDecision, Signal } from "./types.js";

export function evaluateRisk(signal: Signal, config: RiskConfig): RiskDecision {
  if (signal.action === "HOLD") {
    return {
      status: "APPROVED",
      quantity: 0,
      reason: "HOLD signal — no order to evaluate, risk check not applicable.",
    };
  }

  if (config.quantity > config.maxPosition) {
    return {
      status: "SKIPPED",
      quantity: 0,
      reason: `Requested quantity ${config.quantity} exceeds max position ${config.maxPosition} — order skipped.`,
    };
  }

  return {
    status: "APPROVED",
    quantity: config.quantity,
    reason: `Quantity ${config.quantity} is within max position ${config.maxPosition} — approved for paper execution.`,
  };
}
