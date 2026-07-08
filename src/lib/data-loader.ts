// src/lib/data-loader.ts
// Reads data/site.json and data/uptime/ files at Astro build time to compute site summaries

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MonitorRun, SiteDefinition, SiteSummary } from "./types";

const DATA_DIR = join(process.cwd(), "data");
const UPTIME_DIR = join(DATA_DIR, "uptime");
const SOURCE_FILE = join(DATA_DIR, "site.json");
const ICONS_DIR = join(process.cwd(), "public", "siteIcons");

function getLocalIconSet(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ICONS_DIR)) return map;
  try {
    for (const f of readdirSync(ICONS_DIR)) {
      const match = f.match(/^(.+)\.(png|ico|svg|webp)$/i);
      if (match) map.set(match[1], `/monitor/siteIcons/${f}`);
    }
  } catch {}
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
  try {
    return JSON.parse(readFileSync(SOURCE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function parseJsonLines(content: string): MonitorRun[] {
  const runs: MonitorRun[] = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try { runs.push(JSON.parse(line) as MonitorRun); } catch {}
  }
  return runs;
}

export function loadAllMonitorRuns(): MonitorRun[] {
  const runs: MonitorRun[] = [];
  if (!existsSync(UPTIME_DIR)) return runs;

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
  return runs;
}

function computeUptime(siteId: string, runs: MonitorRun[]): { uptime: number; total: number; up: number } {
  let up = 0, total = 0;
  for (const run of runs) {
    const s = run.sites.find((s) => s.id === siteId);
    if (s) { total++; if (s.status === "up") up++; }
  }
  return { uptime: total > 0 ? Math.round((up / total) * 10000) / 100 : 100, total, up };
}

function computeAvgLatency(siteId: string, runs: MonitorRun[]): number | null {
  let t = 0, c = 0;
  for (const run of runs) {
    const s = run.sites.find((s) => s.id === siteId);
    if (!s) continue;
    if (s.latency !== null) {
      t += s.latency; c++;
    }
  }
  return c > 0 ? Math.round(t / c) : null;
}

function buildHistory(siteId: string, runs: MonitorRun[]): SiteSummary["history"] {
  const result: SiteSummary["history"] = [];
  for (const run of runs) {
    const s = run.sites.find((s) => s.id === siteId);
    if (s) {
      result.push({ timestamp: run.timestamp, status: s.status, latency: s.latency });
    }
    // Skip runs where the site was not present — no actual check data
  }
  return result;
}

function getRecentRuns(runs: MonitorRun[], hours: number): MonitorRun[] {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hours);
  let start = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (new Date(runs[i].timestamp) < cutoff) { start = i + 1; break; }
  }
  return runs.slice(start);
}

// Compute per-day status for last 7 days (oldest first)
function computeDailyStatus(siteId: string, runs: MonitorRun[]): Array<"up" | "down" | "mixed" | "nodata"> {
  const result: Array<"up" | "down" | "mixed" | "nodata"> = [];
  for (let d = 6; d >= 0; d--) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const ds = date.toISOString().slice(0, 10);
    let up = 0, down = 0;
    for (const run of runs) {
      if (!run.timestamp.startsWith(ds)) continue;
      const s = run.sites.find((s) => s.id === siteId);
      if (s) { if (s.status === "up") up++; else down++; }
    }
    if (up === 0 && down === 0) result.push("nodata");
    else if (down === 0) result.push("up");
    else if (up === 0) result.push("down");
    else result.push("mixed");
  }
  return result;
}

export function getLatestTimestamp(): string | null {
  const runs = loadAllMonitorRuns();
  return runs.length > 0 ? runs[runs.length - 1].timestamp : null;
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
    const csr = latestRun?.sites.find((s) => s.id === site.id);
    const u24 = computeUptime(site.id, runs24h);
    const u7d = computeUptime(site.id, runs7d);
    const u30d = computeUptime(site.id, runs30d);
    const avgLat = computeAvgLatency(site.id, runs24h);
    const history = buildHistory(site.id, allRuns.slice(-336));
    const dailyStatus = computeDailyStatus(site.id, allRuns);

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
  return summaries;
}
