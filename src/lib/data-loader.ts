// src/lib/data-loader.ts
// Reads data/site.json and data/uptime/ files at Astro build time to compute site summaries

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DailyCheckCount, MonitorRun, SiteDefinition, SiteResult, SiteSummary } from "./types";
// Plain ESM rather than a sibling .ts module: scripts/monitor.mjs decodes the
// same URLs and cannot import TypeScript on the Node version this package
// declares support for.
import { decodeUrl } from "./site-url.mjs";

const DATA_DIR = join(process.cwd(), "data");
const UPTIME_DIR = join(DATA_DIR, "uptime");
const SOURCE_FILE = join(DATA_DIR, "site.json");
const ICONS_DIR = join(process.cwd(), "public", "siteIcons");

/** Per-site history entries kept in the built pages. */
const HISTORY_LIMIT = 336;

function getLocalIconSet(): Map<string, string> {
  if (cachedIconSet) return cachedIconSet;
  const map = new Map<string, string>();
  if (!existsSync(ICONS_DIR)) {
    cachedIconSet = map;
    return map;
  }
  try {
    for (const f of readdirSync(ICONS_DIR)) {
      const match = f.match(/^(.+)\.(png|ico|svg|webp)$/i);
      if (match) map.set(match[1], `/monitor/siteIcons/${f}`);
    }
  } catch {}
  cachedIconSet = map;
  return map;
}

function resolveFaviconUrl(site: SiteDefinition, iconSet: Map<string, string>): string | null {
  const favicon = site.favicon?.trim();
  if (favicon && /^https?:\/\//i.test(favicon)) return favicon;
  if (favicon && favicon.startsWith("./")) {
    const base = favicon.replace(/^\.\//, "").replace(/\.[^.]+$/, "");
    for (const ext of ["png", "ico", "svg", "webp"]) {
      const key = `${base}.${ext}`;
      const url = `/monitor/siteIcons/${key}`;
      if (existsSync(join(ICONS_DIR, key))) return url;
    }
  }
  const found = iconSet.get(site.id);
  return found || null;
}

export function loadSiteDefinitions(): SiteDefinition[] {
  if (cachedSiteDefinitions) return cachedSiteDefinitions;
  try {
    cachedSiteDefinitions = JSON.parse(readFileSync(SOURCE_FILE, "utf-8")) as SiteDefinition[];
  } catch {
    cachedSiteDefinitions = [];
  }
  return cachedSiteDefinitions;
}

/*
 * Build-time caching.
 *
 * Astro renders every page in one Node process, so this module is evaluated
 * once but its helpers run once per page — 341 times for the site pages alone.
 * Both the parsed data and the site-level summaries are derived purely from
 * files that do not change during a build, so they are computed once and
 * reused. Nothing here mutates the cached values, but callers must not either;
 * treat what these functions return as read-only.
 *
 * `undefined` means "not computed yet" so a genuine empty result still caches.
 */
let cachedRuns: MonitorRun[] | undefined;
let cachedSiteDefinitions: SiteDefinition[] | undefined;
let cachedSummaries: SiteSummary[] | undefined;
let cachedLatestTimestamp: string | null | undefined;
let cachedDailyCheckCounts: DailyCheckCount[] | undefined;
let cachedIconSet: Map<string, string> | undefined;

function parseJsonLines(content: string): MonitorRun[] {
  const runs: MonitorRun[] = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try { runs.push(JSON.parse(line) as MonitorRun); } catch {}
  }
  return runs;
}

export function loadAllMonitorRuns(): MonitorRun[] {
  if (cachedRuns) return cachedRuns;

  const runs: MonitorRun[] = [];
  if (!existsSync(UPTIME_DIR)) {
    cachedRuns = runs;
    return runs;
  }

  const years = readdirSync(UPTIME_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const year of years) {
    const yearPath = join(UPTIME_DIR, year.name);
    for (const f of readdirSync(yearPath)) {
      if (/^\d{2}\.jsonl$/.test(f)) {
        try { runs.push(...parseJsonLines(readFileSync(join(yearPath, f), "utf-8"))); } catch {}
      }
    }
    const months = readdirSync(yearPath, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const month of months) {
      const monthPath = join(yearPath, month.name);
      for (const f of readdirSync(monthPath)) {
        if (/^\d{2}\.jsonl$/.test(f)) {
          try { runs.push(...parseJsonLines(readFileSync(join(monthPath, f), "utf-8"))); } catch {}
        }
      }
      const days = readdirSync(monthPath, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const day of days) {
        const dayPath = join(monthPath, day.name);
        for (const f of readdirSync(dayPath)) {
          if (f.endsWith(".json")) {
            try { runs.push(JSON.parse(readFileSync(join(dayPath, f), "utf-8")) as MonitorRun); } catch {}
          }
        }
      }
    }
  }
  runs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  cachedRuns = runs;
  return runs;
}

/*
 * Per-run lookups by site id.
 *
 * The computations below are run for every site, and each one walked the whole
 * run list calling `.find()` on the run's sites array — sites x runs probes,
 * about 400k of them, re-paid on every page. Indexing the runs by site id once
 * turns those scans into a map lookup.
 *
 * The index lives beside the cached runs and is rebuilt with them.
 */
let cachedIndex: Map<string, RunSiteEntry[]> | undefined;

interface RunSiteEntry {
  /** Position in the sorted runs array, so callers can keep run order. */
  index: number;
  timestamp: string;
  status: SiteResult["status"];
  latency: number | null;
}

function runsBySite(): Map<string, RunSiteEntry[]> {
  if (cachedIndex) return cachedIndex;
  const index = new Map<string, RunSiteEntry[]>();
  const runs = loadAllMonitorRuns();
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    for (const s of run.sites) {
      let list = index.get(s.id);
      if (!list) {
        list = [];
        index.set(s.id, list);
      }
      list.push({ index: i, timestamp: run.timestamp, status: s.status, latency: s.latency });
    }
  }
  cachedIndex = index;
  return index;
}

/** Entries for one site, oldest-first, matching the order of loadAllMonitorRuns. */
function entriesForSite(siteId: string): RunSiteEntry[] {
  return runsBySite().get(siteId) ?? [];
}

/**
 * Entries for one site since `hours` ago (or all of them when omitted).
 * Replaces the old "scan every run, .find() the site" pattern.
 */
function recentEntries(siteId: string, hours?: number): RunSiteEntry[] {
  const all = entriesForSite(siteId);
  if (hours === undefined) return all;
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hours);
  // Entries are oldest-first, so the window is a suffix; scan back to find it.
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (new Date(all[i].timestamp) < cutoff) { start = i + 1; break; }
  }
  return all.slice(start);
}

function computeUptime(entries: RunSiteEntry[]): { uptime: number; total: number; up: number } {
  let up = 0, total = 0;
  for (const e of entries) {
    total++;
    if (e.status === "up") up++;
  }
  return { uptime: total > 0 ? Math.round((up / total) * 10000) / 100 : 100, total, up };
}

function computeAvgLatency(entries: RunSiteEntry[]): number | null {
  let t = 0, c = 0;
  for (const e of entries) {
    if (e.latency !== null) {
      t += e.latency; c++;
    }
  }
  return c > 0 ? Math.round(t / c) : null;
}

function buildHistory(entries: RunSiteEntry[], limit: number): SiteSummary["history"] {
  // Entries are oldest-first; the history contract is also oldest-first, so
  // take the newest `limit` and keep their order.
  const start = Math.max(0, entries.length - limit);
  return entries.slice(start).map((e) => ({ timestamp: e.timestamp, status: e.status, latency: e.latency }));
}

// Compute per-day status for last 7 days (oldest first)
function computeDailyStatus(entries: RunSiteEntry[]): Array<"up" | "down" | "mixed" | "nodata"> {
  const result: Array<"up" | "down" | "mixed" | "nodata"> = [];
  // Bucket this site's entries by UTC date once, instead of rescanning the
  // whole run list for each of the 7 days.
  const byDay = new Map<string, { up: number; down: number }>();
  for (const e of entries) {
    const ds = e.timestamp.slice(0, 10);
    let b = byDay.get(ds);
    if (!b) { b = { up: 0, down: 0 }; byDay.set(ds, b); }
    if (e.status === "up") b.up++; else b.down++;
  }
  for (let d = 6; d >= 0; d--) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const ds = date.toISOString().slice(0, 10);
    const b = byDay.get(ds);
    const up = b?.up ?? 0, down = b?.down ?? 0;
    if (up === 0 && down === 0) result.push("nodata");
    else if (down === 0) result.push("up");
    else if (up === 0) result.push("down");
    else result.push("mixed");
  }
  return result;
}

export function getLatestTimestamp(): string | null {
  if (cachedLatestTimestamp !== undefined) return cachedLatestTimestamp;
  const runs = loadAllMonitorRuns();
  cachedLatestTimestamp = runs.length > 0 ? runs[runs.length - 1].timestamp : null;
  return cachedLatestTimestamp;
}

/** The following UTC calendar day. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Monitor runs per UTC calendar day, oldest first and contiguous, for the
 * dashboard heatmap.
 *
 * Days are bucketed on the date part of the run timestamp — the same UTC day
 * boundary computeDailyStatus and DISPLAY_TIME_ZONE use — so "a day" means the
 * same span everywhere on the page.
 *
 * A day with no run is kept as 0 rather than dropped: on a monitor dashboard a
 * silent day is the finding, not an absence to hide. The series is extended to
 * today even when monitoring stopped earlier, so a lapse shows as trailing
 * empty days instead of the window quietly shrinking to the last run.
 */
export function computeDailyCheckCounts(): DailyCheckCount[] {
  if (cachedDailyCheckCounts) return cachedDailyCheckCounts;

  const byDay = new Map<string, number>();
  for (const run of loadAllMonitorRuns()) {
    const day = run.timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  const days = [...byDay.keys()].sort();
  const series: DailyCheckCount[] = [];
  if (days.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const newest = days[days.length - 1];
    // ISO dates compare correctly as plain strings.
    const end = newest > today ? newest : today;
    for (let day = days[0]; day <= end; day = nextDay(day)) {
      series.push({ date: day, count: byDay.get(day) ?? 0 });
    }
  }

  cachedDailyCheckCounts = series;
  return series;
}

export function computeSiteSummaries(): SiteSummary[] {
  if (cachedSummaries) return cachedSummaries;

  const sites = loadSiteDefinitions();
  const allRuns = loadAllMonitorRuns();
  const iconSet = getLocalIconSet();

  // The current status comes from the newest run that actually contains the
  // site, so look that up per site rather than assuming it is the last run.
  const latestRun = allRuns.length > 0 ? allRuns[allRuns.length - 1] : null;
  const latestRunIndex = allRuns.length - 1;

  const summaries: SiteSummary[] = sites.map((site) => {
    const entries = entriesForSite(site.id);
    // Newest entry, when it belongs to the newest run overall.
    const newest = entries.length > 0 ? entries[entries.length - 1] : undefined;
    const csr = newest && newest.index === latestRunIndex && latestRun ? { latency: newest.latency } : undefined;
    const u24 = computeUptime(recentEntries(site.id, 24));
    const u7d = computeUptime(recentEntries(site.id, 7 * 24));
    const u30d = computeUptime(recentEntries(site.id, 30 * 24));
    const avgLat = computeAvgLatency(recentEntries(site.id, 24));
    const history = buildHistory(entries, HISTORY_LIMIT);
    const dailyStatus = computeDailyStatus(entries);

    let currentStatus: SiteSummary["currentStatus"];
    let currentLatency: number | null = null;
    if (site.isDead) {
      currentStatus = "dead";
    } else {
      const dataDays = dailyStatus.filter((s) => s !== "nodata");
      currentStatus = dataDays.length > 0 && dataDays.every((s) => s === "down") ? "down" : "up";
      if (csr) {
        currentLatency = csr.latency;
      }
    }

    return {
      id: site.id, name: site.name, type: site.type,
      description: site.description, urls: site.urls,
      favicon: site.favicon, faviconUrl: resolveFaviconUrl(site, iconSet),
      isDead: site.isDead,
      currentStatus, currentLatency,
      // Decoded here, once per site: the definition stores these ROT13-encoded.
      primaryUrl: site.urls.length > 0 ? decodeUrl(site.urls[0]) : null,
      uptime24h: u24.uptime, uptime7d: u7d.uptime, uptime30d: u30d.uptime,
      avgLatency24h: avgLat,
      dailyStatus,
      history,
    };
  });

  summaries.sort((a, b) => {
    const order = { up: 0, down: 1, dead: 2 };
    const d = (order[a.currentStatus] ?? 3) - (order[b.currentStatus] ?? 3);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  cachedSummaries = summaries;
  return summaries;
}
