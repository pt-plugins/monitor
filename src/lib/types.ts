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
