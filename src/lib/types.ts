// site/src/lib/types.ts

export interface SiteDefinition {
  id: string;
  name: string;
  urls: string[];
  type: string;
  description: string;
  favicon: string;
  isDead: boolean;
}

export interface SiteResult {
  id: string;
  status: "up" | "down";
  latency: number | null;
}

export interface MonitorRun {
  timestamp: string;
  sites: SiteResult[];
}

/** One UTC calendar day of monitoring activity, for the dashboard heatmap. */
export interface DailyCheckCount {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Monitor runs started that day; 0 for a day that has none. */
  count: number;
}

export interface SiteSummary {
  id: string;
  name: string;
  type: string;
  description: string;
  urls: string[];
  favicon: string;
  faviconUrl: string | null;
  isDead: boolean;
  currentStatus: "up" | "down" | "dead";
  currentLatency: number | null;
  /**
   * First URL in the site definition, decoded. The monitor probes a site's URLs
   * in this order and stops at the first one that answers, so this is the
   * address it normally used.
   */
  primaryUrl: string | null;
  uptime24h: number; // 0-100
  uptime7d: number;
  uptime30d: number;
  avgLatency24h: number | null;
  dailyStatus: Array<"up" | "down" | "mixed" | "nodata">; // last 7 days, oldest first
  history: Array<{
    timestamp: string;
    status: "up" | "down";
    latency: number | null;
  }>;
}
