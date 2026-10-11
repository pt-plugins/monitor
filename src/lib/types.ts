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

/*
 * Certificate and domain expiry, as written by scripts/certificates.mjs.
 *
 * This file holds one snapshot and no history: the expiry dates it carries are
 * the only thing the pages read, and a new run overwrites them outright.
 *
 * `sites` is keyed by site id, the way request-overrides.json keys its own
 * overrides — the id is written once, as the key, rather than repeated in every
 * record — and an entry carries no hostnames: not the host whose certificate
 * was read, nor the registrable domain looked up, so the snapshot adds nothing
 * about which addresses a site answers on.
 *
 * A run only measures what the previous snapshot cannot still answer for, so
 * each of the two fields dates itself: `checkedAt` is when *that* date was
 * read, which may be well before the snapshot's own timestamp.
 */
export interface CertificateReport {
  timestamp: string;
  sites: Record<string, CertificateSite>;
}

export interface CertificateSite {
  ssl: {
    /** Certificate notAfter, ISO 8601; null when no certificate was read. */
    notAfter: string | null;
    issuer: string | null;
    /** Set when the chain or the name did not verify, though it was readable. */
    trustError: string | null;
    error: string | null;
    /** When this date was read — not when the snapshot was written. */
    checkedAt: string;
  };
  domain: {
    /** Registration expiry, ISO 8601; null when the registry did not give one. */
    expiresAt: string | null;
    registrar: string | null;
    error: string | null;
    /** When this date was read — not when the snapshot was written. */
    checkedAt: string;
  };
}

/**
 * A site's certificate and domain expiry with the time left computed at build
 * time, so a snapshot a few days old still reads as current.
 *
 * `updatedAt` is when the snapshot was written; each field's own `checkedAt` is
 * when that date was read, which the incremental run may let lag behind it.
 */
export interface SiteCertificate {
  updatedAt: string;
  ssl: {
    notAfter: string | null;
    issuer: string | null;
    trustError: string | null;
    error: string | null;
    /** When this date was read; null when the snapshot predates the field. */
    checkedAt: string | null;
    /** Whole days until notAfter; negative once expired. */
    daysRemaining: number | null;
  };
  domain: {
    expiresAt: string | null;
    registrar: string | null;
    error: string | null;
    /** When this date was read; null when the snapshot predates the field. */
    checkedAt: string | null;
    /** Whole days until expiresAt; negative once expired. */
    daysRemaining: number | null;
  };
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
  /** Null when the certificate snapshot has never been collected. */
  certificate: SiteCertificate | null;
}
