// src/lib/history-fetch.ts
// Shared constants + pure helpers for browser-side history fetching.
// Runs in the browser (bundled into the page script), so it must not import node builtins.

export const HISTORY_REPO = "pt-plugins/monitor";
export const HISTORY_BRANCH = "main";
export const HISTORY_DATA_DIR = "data/uptime";

/**
 * Earliest month with merged history data. Nothing exists before this, so requests
 * for earlier months would only produce pointless 404s.
 */
export const EARLIEST_YEAR = 2026;
export const EARLIEST_MONTH = 6;

/** Cache API bucket for history payloads. */
export const CACHE_NAME = "ptd-monitor-history-v1";

/** localStorage key holding the optional GitHub token. */
export const TOKEN_STORAGE_KEY = "ptd-monitor:gh-token";

/** Monthly file: data/uptime/YYYY/MM.jsonl */
export function monthlyFilePath(year: number, month: number): string {
  return `${HISTORY_DATA_DIR}/${year}/${pad2(month)}.jsonl`;
}

/** Daily file: data/uptime/YYYY/MM/DD.jsonl */
export function dailyFilePath(year: number, month: number, day: number): string {
  return `${HISTORY_DATA_DIR}/${year}/${pad2(month)}/${pad2(day)}.jsonl`;
}

/**
 * REST endpoint that returns the raw file body.
 * The `.raw` media type avoids base64 decoding and the 1 MB inline-content limit.
 */
export function contentsApiUrl(path: string): string {
  return `https://api.github.com/repos/${HISTORY_REPO}/contents/${path}?ref=${HISTORY_BRANCH}`;
}

/** Absolute month index (year * 12 + month - 1), for ordering/range math. */
export function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

export function earliestMonthIndex(): number {
  return monthIndex(EARLIEST_YEAR, EARLIEST_MONTH);
}

/** True when the given year/month is at or after the earliest month that has data. */
export function isWithinHistoryRange(year: number, month: number): boolean {
  return monthIndex(year, month) >= earliestMonthIndex();
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
