// src/lib/history-fetch.ts
// Shared constants + pure helpers for browser-side history fetching.
// Runs in the browser (bundled into the page script), so it must not import node builtins.

export const HISTORY_REPO = "pt-plugins/monitor";
export const HISTORY_BRANCH = "main";
export const HISTORY_DATA_DIR = "data/uptime";

/** Cache schema version — bump to invalidate all previously cached payloads. */
export const CACHE_VERSION = 1;
export const CACHE_KEY_PREFIX = `ptd-monitor:history:v${CACHE_VERSION}`;

/** Monthly file: data/uptime/YYYY/MM.jsonl */
export function monthlyFilePath(year: number, month: number): string {
  return `${HISTORY_DATA_DIR}/${year}/${pad2(month)}.jsonl`;
}

/** Daily file: data/uptime/YYYY/MM/DD.jsonl */
export function dailyFilePath(year: number, month: number, day: number): string {
  return `${HISTORY_DATA_DIR}/${year}/${pad2(month)}/${pad2(day)}.jsonl`;
}

export function rawFileUrl(path: string): string {
  return `https://raw.githubusercontent.com/${HISTORY_REPO}/${HISTORY_BRANCH}/${path}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface HistoryEntry {
  timestamp: string;
  status: "up" | "down";
  latency: number | null;
}

interface RawSiteResult {
  id?: unknown;
  status?: unknown;
  latency?: unknown;
}

interface RawRun {
  timestamp?: unknown;
  sites?: unknown;
}

/**
 * Parse a JSONL payload and extract the entries belonging to `siteId`.
 * Malformed lines are skipped instead of failing the whole file.
 */
export function parseJsonlForSite(text: string, siteId: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let run: RawRun;
    try {
      run = JSON.parse(trimmed) as RawRun;
    } catch {
      continue;
    }

    if (typeof run.timestamp !== "string" || !Array.isArray(run.sites)) continue;

    const result = (run.sites as RawSiteResult[]).find((s) => s && s.id === siteId);
    if (!result) continue;

    const status = result.status === "up" ? "up" : result.status === "down" ? "down" : null;
    if (!status) continue;

    const latency =
      typeof result.latency === "number" && Number.isFinite(result.latency) ? result.latency : null;

    entries.push({ timestamp: run.timestamp, status, latency });
  }
  return entries;
}

/** Build the list of monthly file paths covering `monthsBack` whole months before lastMonth. */
export function monthsBackFrom(lastMonth: number, monthsBack: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (let i = 1; i <= monthsBack; i++) {
    const total = lastMonth - i;
    const year = Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    out.push({ year, month: month + 1 });
  }
  return out;
}

/** Stable cache key for one fetched file. */
export function cacheKeyFor(path: string): string {
  return `${CACHE_KEY_PREFIX}:${path}`;
}
