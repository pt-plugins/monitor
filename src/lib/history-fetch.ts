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

/**
 * Cache API bucket for history payloads. Entries hold the raw JSONL body of a
 * data file, unfiltered, so one entry serves every site that shares the file.
 */
export const CACHE_NAME = "ptd-monitor-history-v2";

/**
 * Buckets from earlier versions. They stored a payload already filtered to one
 * site under a site-specific key, so they cannot be read by the current code
 * and are deleted on first load.
 */
export const LEGACY_CACHE_PREFIX = "ptd-monitor-history-v1";

/** localStorage key holding the optional GitHub token. */
export const TOKEN_STORAGE_KEY = "ptd-monitor:gh-token";

/**
 * Timezone every check timestamp is rendered in, on both the build and in the
 * browser.
 *
 * Timestamps in the data are UTC. Formatting them without an explicit zone made
 * the displayed time depend on where the code happened to run: the build
 * formatted in the CI machine's zone (UTC) while Extended History formatted in
 * the visitor's zone, so a record shown by both was off by the visitor's offset.
 * Pinning one zone keeps built-in and fetched rows consistent everywhere.
 */
export const DISPLAY_TIME_ZONE = "UTC";

/** Short suffix appended to a formatted check time so the zone is not implicit. */
export const DISPLAY_TIME_ZONE_LABEL = "UTC";

/**
 * Format a check timestamp for the Checks History table, in DISPLAY_TIME_ZONE.
 * Shared by the build-time page and the browser-side merge so the two agree.
 *
 * Rendered as `YYYY-MM-DD HH:mm:ss`: the year is part of the value because the
 * table can now span several years (Extended History's "All history" range) and
 * seconds because a day holds many checks, often within the same minute.
 *
 * Note the locale is `en-CA`, not something zone-flavoured like `sv-SE`. A
 * locale only picks formatting conventions (here the ISO `YYYY-MM-DD` order and
 * a 24-hour clock); it never implies a timezone. The zone comes solely from
 * DISPLAY_TIME_ZONE below — dropping that option would fall back to the
 * runtime's zone, which is the bug this function exists to prevent.
 */
export function formatCheckTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const date = d.toLocaleDateString("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: DISPLAY_TIME_ZONE,
    });
    const time = d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: DISPLAY_TIME_ZONE,
    });
    return `${date} ${time}`;
  } catch {
    // Older engines without full Intl: fall back to the raw UTC fields.
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    );
  }
}

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
