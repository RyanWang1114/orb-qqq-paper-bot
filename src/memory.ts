// Two-file memory system: data/ledger.csv (append-only trade log) and
// data/learnings.md (plain-English lessons). Both are built ONLY from real
// signals/trades produced by evaluateBar()/replay — nothing here ever seeds
// a fake loss, invents a candle, or forces a failure. If there is no real
// loss on record, that is exactly what these files will say.

import fs from "node:fs";
import path from "node:path";
import { LedgerAction, LedgerOutcome, LedgerRow, ReplayMode } from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
export const LEDGER_PATH = path.join(DATA_DIR, "ledger.csv");
export const LEARNINGS_PATH = path.join(DATA_DIR, "learnings.md");

const LEDGER_HEADER = "timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl";

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureLedgerExists(): void {
  ensureDataDir();
  if (!fs.existsSync(LEDGER_PATH)) {
    fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n", "utf8");
  }
}

function csvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export function appendLedgerRow(row: LedgerRow): void {
  ensureLedgerExists();
  const line = [
    row.timestamp,
    row.symbol,
    row.action,
    row.price.toFixed(2),
    String(row.quantity),
    csvField(row.reason),
    row.mode,
    row.outcome,
    row.pnl === null ? "" : row.pnl.toFixed(2),
  ].join(",");
  fs.appendFileSync(LEDGER_PATH, line + "\n", "utf8");
}

export function readLedger(): LedgerRow[] {
  ensureLedgerExists();
  const content = fs.readFileSync(LEDGER_PATH, "utf8").trim();
  const lines = content.split("\n");
  if (lines.length <= 1) return []; // header only, or empty

  return lines.slice(1).map((line) => {
    const [timestamp, symbol, action, price, quantity, reason, mode, outcome, pnl] = parseCsvLine(line);
    return {
      timestamp,
      symbol,
      action: action as LedgerAction,
      price: Number(price),
      quantity: Number(quantity),
      reason,
      mode: mode as ReplayMode,
      outcome: outcome as LedgerOutcome,
      pnl: pnl === "" ? null : Number(pnl),
    };
  });
}

/**
 * Insert-or-update a named section in learnings.md. Re-running replay:raw over
 * overlapping history updates the existing lesson with fresh real numbers
 * instead of duplicating it endlessly.
 */
export function upsertLearning(sectionTitle: string, body: string): void {
  ensureDataDir();
  const heading = `## ${sectionTitle}`;
  const section = `${heading}\n${body.trim()}\n`;

  if (!fs.existsSync(LEARNINGS_PATH)) {
    fs.writeFileSync(
      LEARNINGS_PATH,
      "# Learnings\n\nPlain-English lessons derived from simulated trade outcomes using market data. These are not brokerage results.\n\n" +
        section +
        "\n",
      "utf8"
    );
    return;
  }

  const content = fs.readFileSync(LEARNINGS_PATH, "utf8");
  const headingEscaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(`${headingEscaped}\\n[\\s\\S]*?(?=\\n## |$)`, "m");

  if (sectionRegex.test(content)) {
    fs.writeFileSync(LEARNINGS_PATH, content.replace(sectionRegex, section + "\n"), "utf8");
  } else {
    fs.writeFileSync(LEARNINGS_PATH, content.trimEnd() + "\n\n" + section + "\n", "utf8");
  }
}

export function readLearnings(): string {
  if (!fs.existsSync(LEARNINGS_PATH)) return "";
  return fs.readFileSync(LEARNINGS_PATH, "utf8");
}

export function memoryFilesExist(): { ledger: boolean; learnings: boolean } {
  return { ledger: fs.existsSync(LEDGER_PATH), learnings: fs.existsSync(LEARNINGS_PATH) };
}

/** `npm run memory:reset` — clears both memory files back to empty. Real reset, not a fake win. */
export function resetMemory(): void {
  ensureDataDir();
  fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n", "utf8");
  if (fs.existsSync(LEARNINGS_PATH)) fs.unlinkSync(LEARNINGS_PATH);
}
