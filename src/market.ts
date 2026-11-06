// Real market data only. No generated candles, no fixtures.
// Fetches actual historical/recent bars from Alpaca's Market Data API (IEX feed, free tier).
//
// Credentials: read from environment variables ALPACA_API_KEY / ALPACA_SECRET_KEY.
// This file never logs, prints, or embeds the key/secret values anywhere.
// It reuses the same credentials file already set up for the Alpaca MCP server
// (~/.alpaca-mcp.env) so nothing needs to be re-entered or pasted into chat/code.

import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";
import { Candle } from "./types.js";

dotenv.config(); // local .env in this project, if present

if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
  const fallback =
    process.env.ALPACA_ENV_FILE ?? path.join(os.homedir(), ".alpaca-mcp.env");
  dotenv.config({ path: fallback });
}

const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";

function getAuthHeaders(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) {
    throw new Error(
      "Missing Alpaca credentials. Set ALPACA_API_KEY and ALPACA_SECRET_KEY as environment " +
        "variables (or in a local .env file, or via ALPACA_ENV_FILE pointing at your existing " +
        "credentials file). Never paste keys into chat, code, or logs."
    );
  }
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function toCandle(bar: AlpacaBar): Candle {
  return {
    timestamp: bar.t,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
}

/**
 * Most recent N bars up to now — used by `scan` for a live check.
 * Alpaca defaults to "today only" when no start/end is given, which is empty
 * outside market hours, so we explicitly look back a few days and take the
 * most recent `limit` bars (covers weekends/pre-market/after-hours gaps).
 */
export async function getRecentBars(
  symbol: string,
  timeframe: string,
  limit: number
): Promise<Candle[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 24 * 60 * 60 * 1000);

  const url = new URL(`${ALPACA_DATA_URL}/stocks/${symbol}/bars`);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("feed", "iex");
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("sort", "desc"); // most recent first, so `limit` keeps the latest bars

  const res = await fetch(url.toString(), { headers: getAuthHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca market data request failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { bars: AlpacaBar[] };
  return (data.bars ?? []).map(toCandle).reverse(); // back to ascending chronological order
}

/** All bars in [startISO, endISO), paginated — used by `replay:raw` for backtesting. */
export async function getBarsRange(
  symbol: string,
  timeframe: string,
  startISO: string,
  endISO: string
): Promise<Candle[]> {
  const bars: Candle[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${ALPACA_DATA_URL}/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", startISO);
    url.searchParams.set("end", endISO);
    url.searchParams.set("feed", "iex");
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("limit", "10000");
    url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url.toString(), { headers: getAuthHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca market data request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as {
      bars: AlpacaBar[];
      next_page_token?: string;
    };
    bars.push(...(data.bars ?? []).map(toCandle));
    pageToken = data.next_page_token;
  } while (pageToken);

  return bars;
}
