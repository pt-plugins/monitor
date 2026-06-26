// src/lib/data-loader.ts
// Reads data/site.json and data/uptime/ files at Astro build time to compute site summaries

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MonitorRun, SiteDefinition, SiteSummary } from "./types";

const DATA_DIR = join(process.cwd(), "data");
const UPTIME_DIR = join(DATA_DIR, "uptime");
const SOURCE_FILE = join(DATA_DIR, "site.json");
const ICONS_DIR = join(process.cwd(), "public", "siteIcons");

// Build a set of available local favicon filenames (without extension)
// Icons are copied from PT-depiler by update-source.mjs
function getLocalIconSet(): Map<string, string> {
  const map = new Map<string, string>();

  if (!existsSync(ICONS_DIR)) return map;

  try {
    for (const f of readdirSync(ICONS_DIR)) {
      const match = f.match(/^(.+)\.(png|ico|svg)$/i);
      if (match) {
        map.set(match[1], `/monitor/siteIcons/${f}`);
      }
    }
  } catch {}

  return map;
}

// Resolve favicon URL for a site
function resolveFaviconUrl(site: SiteDefinition, iconSet: Map<string, string>): string | null {
  const favicon = site.favicon?.trim();

  if (favicon && /^https?:\/\//i.test(favicon)) {
    return favicon;
  }

  if (favicon && favicon.startsWith("./")) {
    const base = favicon.replace(/^\.\//, "").replace(/\.[^.]+$/, "");
    for (const ext of ["png", "ico", "svg"]) {
      const key = `${base}.${ext}`;
      const url = `/monitor/siteIcons/${key}`;
      if (existsSync(join(ICONS_DIR, key))) return url;
    }
  }

  const found = iconSet.get(site.id);
  if (found) return found;

  return null;
}

// Load site definitions
export function loadSiteDefinitions(): SiteDefinition[] {
  try {
    const raw = readFileSync(SOURCE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    console.warn("[data-loader] No source/site.json found, returning empty list");
    return [];
  }
}

// Parse JSONLines content into MonitorRun array
function parseJsonLines(content: string): MonitorRun[] {
  const runs: MonitorRun[] = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try {
      runs.push(JSON.parse(line) as MonitorRun);
    } catch {}
  }
  return runs;
}

// Load all monitor runs from data directory (raw .json + merged .jsonl)
export function loadAllMonitorRuns(): MonitorRun[] {
  const runs: MonitorRun[] = [];

  if (!existsSync(UPTIME_DIR)) {
    return runs;
  }

  const years = readdirSync(UPTIME_DIR, { withFileTypes: true }).filter((e) =>
    e.isDirectory()
  );

  for (const year of years) {
    const yearPath = join(UPTIME_DIR, year.name);

    // Monthly merged files (MM.jsonl) at year level
    for (const f of readdirSync(yearPath)) {
      if (/^\d{2}\.jsonl$/.test(f)) {
        try {
          const content = readFileSync(join(yearPath, f), "utf-8");
          runs.push(...parseJsonLines(content));
        } catch {}
      }
    }

    const months = readdirSync(yearPath, { withFileTypes: true }).filter((e) =>
      e.isDirectory()
    );

    for (const month of months) {
      const monthPath = join(yearPath, month.name);

      // Daily merged files (DD.jsonl) at month level
      for (const f of readdirSync(monthPath)) {
        if (/^\d{2}\.jsonl$/.test(f)) {
          try {
            const content = readFileSync(join(monthPath, f), "utf-8");
            runs.push(...parseJsonLines(content));
          } catch {}
        }
      }

      // Raw per-run files (HH_MM.json) in day directories
      const days = readdirSync(monthPath, { withFileTypes: true }).filter(
        (e) => e.isDirectory()
      );

      for (const day of days) {
        const dayPath = join(monthPath, day.name);
        for (const f of readdirSync(dayPath)) {
          if (f.endsWith(".json")) {
            try {
              const raw = readFileSync(join(dayPath, f), "utf-8");
              runs.push(JSON.parse(raw) as MonitorRun);
            } catch {}
          }
        }
      }
    }
  }

  // Sort by timestamp
  runs.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return runs;
}

// Compute uptime percentage for a site from a set of runs
function computeUptime(
  siteId: string,
  runs: MonitorRun[]
): { uptime: number; total: number; up: number } {
  let up = 0;
  let total = 0;

  for (const run of runs) {
    const siteResult = run.sites.find((s) => s.id === siteId);
    if (siteResult) {
      total++;
      if (siteResult.status === "up") {
        up++;
      }
    }
  }

  return {
    uptime: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
    total,
    up,
  };
}

// Compute average latency for a site from runs
function computeAvgLatency(
  siteId: string,
  runs: MonitorRun[]
): number | null {
  let totalLatency = 0;
  let count = 0;

  for (const run of runs) {
    const siteResult = run.sites.find((s) => s.id === siteId);
    if (siteResult) {
      for (const urlResult of siteResult.urls) {
        if (urlResult.latency !== null) {
          totalLatency += urlResult.latency;
          count++;
        }
      }
    }
  }

  return count > 0 ? Math.round(totalLatency / count) : null;
}

// Build history array for a site
function buildHistory(
  siteId: string,
  runs: MonitorRun[]
): SiteSummary["history"] {
  return runs.map((run) => {
    const siteResult = run.sites.find((s) => s.id === siteId);
    if (siteResult) {
      const minLatency = siteResult.urls
        .filter((u) => u.latency !== null)
        .reduce(
          (min, u) => (u.latency! < min ? u.latency! : min),
          Infinity
        );
      return {
        timestamp: run.timestamp,
        status: siteResult.status,
        latency: minLatency === Infinity ? null : minLatency,
      };
    }
    return {
      timestamp: run.timestamp,
      status: "down" as const,
      latency: null,
    };
  });
}

// Get the last N runs for time-windowed stats
function getRecentRuns(runs: MonitorRun[], hours: number): MonitorRun[] {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hours);

  let start = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (new Date(runs[i].timestamp) < cutoff) {
      start = i + 1;
      break;
    }
  }

  return runs.slice(start);
}

export function getLatestTimestamp(): string | null {
  const runs = loadAllMonitorRuns();
  if (runs.length === 0) return null;
  return runs[runs.length - 1].timestamp;
}

export function computeSiteSummaries(): SiteSummary[] {
  const sites = loadSiteDefinitions();
  const allRuns = loadAllMonitorRuns();
  const iconSet = getLocalIconSet();

  const runs24h = getRecentRuns(allRuns, 24);
  const runs7d = getRecentRuns(allRuns, 7 * 24);
  const runs30d = getRecentRuns(allRuns, 30 * 24);

  const latestRun = allRuns.length > 0 ? allRuns[allRuns.length - 1] : null;

  const summaries: SiteSummary[] = sites.map((site) => {
    const currentSiteResult = latestRun?.sites.find((s) => s.id === site.id);

    const uptime24h = computeUptime(site.id, runs24h);
    const uptime7d = computeUptime(site.id, runs7d);
    const uptime30d = computeUptime(site.id, runs30d);

    const avgLatency24h = computeAvgLatency(site.id, runs24h);
    const history = buildHistory(site.id, allRuns.slice(-336)); // 7 days at 30min intervals

    let currentStatus: SiteSummary["currentStatus"];
    let currentLatency: number | null = null;

    if (site.isDead) {
      currentStatus = "dead";
    } else if (currentSiteResult) {
      currentStatus = currentSiteResult.status;
      currentLatency =
        currentSiteResult.urls
          .filter((u) => u.latency !== null)
          .reduce(
            (min, u) => (u.latency! < min ? u.latency! : min),
            Infinity
          ) ?? null;
      if (currentLatency === Infinity) currentLatency = null;
    } else {
      currentStatus = "down";
    }

    return {
      id: site.id,
      name: site.name,
      type: site.type,
      description: site.description,
      urls: site.urls,
      favicon: site.favicon,
      faviconUrl: resolveFaviconUrl(site, iconSet),
      isDead: site.isDead,
      currentStatus,
      currentLatency,
      uptime24h: uptime24h.uptime,
      uptime7d: uptime7d.uptime,
      uptime30d: uptime30d.uptime,
      avgLatency24h,
      history,
    };
  });

  summaries.sort((a, b) => {
    const order = { up: 0, down: 1, dead: 2 };
    const orderDiff =
      (order[a.currentStatus] ?? 3) - (order[b.currentStatus] ?? 3);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name);
  });

  return summaries;
}
