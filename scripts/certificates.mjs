// scripts/certificates.mjs
// Reads data/site.json and writes one TLS-certificate + domain-expiry snapshot
// to data/certificates.json.
//
// Deliberately separate from scripts/monitor.mjs: a certificate or a domain
// registration changes on the scale of weeks, so this runs every few days (see
// .github/workflows/certificates.yml) rather than every 15 minutes, and it
// keeps no history — the output file is overwritten on every run, because only
// the current expiry dates are ever read.
//
// Two protocols answer the domain question. RDAP is preferred where a registry
// publishes it; the IANA bootstrap maps a TLD to that registry's endpoint, so
// no single redirector (rdap.org) has to absorb every lookup — it rate-limits
// bursts. Registries that publish no RDAP (among them .cn, .me, .de, .eu) are
// asked over WHOIS instead, serially and slowly, because those servers throttle
// bulk querying.
//
// The run is incremental: an expiry the previous snapshot already placed more
// than RECHECK_WITHIN_DAYS away is carried over untouched, so a steady state
// costs a handful of lookups instead of a few hundred — which is also what
// keeps the registries from throttling us. Anything that failed last time,
// anything close enough to expiry to matter, and anything that has gone
// RECHECK_AFTER_DAYS without being read, is measured again.
//
// And when a registry does throttle anyway, that answer ends the run rather
// than the lookup: see stoppedForThrottle below.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import PQueue from "p-queue";
import { decodeUrl } from "../src/lib/site-url.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const SOURCE_FILE = join(DATA_DIR, "site.json");
const OUTPUT_FILE = join(DATA_DIR, "certificates.json");

const TLS_TIMEOUT_MS = 15_000;
const RDAP_TIMEOUT_MS = 20_000;
const WHOIS_TIMEOUT_MS = 20_000;
const RDAP_RETRIES = 3;
const RDAP_BOOTSTRAP_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const CONCURRENCY = 5;
const USER_AGENT = "PTD-Monitor/1.0";

/*
 * A stored date is reused while it is further out than this, in whole days.
 *
 * The threshold sits at or above the points where the page starts warning (14
 * days for a certificate, 30 for a domain), so a value is always re-read no
 * later than the moment it could begin to matter. One number covers both,
 * because the question is the same either way: is this date far enough away
 * that reading it again would tell us nothing?
 */
const RECHECK_WITHIN_DAYS = 30;

/*
 * How long a stored date may stand without being read again, in whole days.
 *
 * Independent of the window above, and it bounds it: however far off an expiry
 * is, no reading older than this is kept, so a value cannot be carried
 * indefinitely. That is what eventually notices a renewal made before the
 * window opened, or a site that changed address, neither of which the window
 * rule can see. Both happen to be 30 today; nothing requires them to match.
 */
const RECHECK_AFTER_DAYS = 30;

const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const WHOIS_REFERRAL_HOST = "whois.iana.org";

/*
 * Public suffixes that carry two labels, so the registrable domain of
 * "pt.example.co.uk" is "example.co.uk" rather than "co.uk".
 *
 * A full Public Suffix List is not worth a dependency here: this list only has
 * to cover the suffixes the monitored sites actually use. A miss is cheap and
 * visible — the lookup for the too-short name comes back with no expiration —
 * so the list can grow from the data.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.jp", "ne.jp", "or.jp",
  "com.tw", "org.tw", "com.hk", "org.hk",
  "co.kr", "co.nz", "co.za", "co.il",
  "com.br", "com.au", "net.au", "org.au", "com.sg",
  "com.mx", "com.tr", "com.ar", "com.pl", "com.ru",
]);

/*
 * A few registry WHOIS servers need more than the bare domain name. DENIC
 * answers with an error unless asked for a domain object in ACE encoding.
 */
const WHOIS_QUERY_PREFIX = { de: "-T dn,ace " };

/*
 * Expiry and registrar labels the registry WHOIS servers in use actually emit.
 * Matched line-anchored so a paragraph of boilerplate mentioning "expiration"
 * cannot be mistaken for a field.
 */
const WHOIS_EXPIRY_PATTERNS = [
  /^Registry Expiry Date:\s*(.+)$/im,
  /^Expiration Time:\s*(.+)$/im,
  /^Expiration Date:\s*(.+)$/im,
  /^Expiry Date:\s*(.+)$/im,
  /^Expires?:?\s*(.+)$/im,
  /^paid-till:\s*(.+)$/im,
  /^renewal date:\s*(.+)$/im,
];

const WHOIS_REGISTRAR_PATTERNS = [
  /^Sponsoring Registrar:\s*(.+)$/im,
  /^Registrar:\s*(.+)$/im,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for IPv4/IPv6 literals, which have no registrable domain to look up. */
function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Registrable domain of a hostname: the last label plus its public suffix. */
function registrableDomain(host) {
  const cleaned = host.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
  const labels = cleaned.split(".");
  if (labels.length <= 2) return cleaned;
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * Parse a date as registries write them.
 *
 * Registry timestamps without a zone ("2027-06-06 02:13:51") are UTC by
 * convention, but `new Date` would read them in the runner's local zone, so
 * they are given an explicit Z rather than reformatted later.
 */
function parseRegistryDate(value) {
  const raw = value.trim();
  if (!raw) return null;
  let text = raw;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) {
    text = `${text.replace(" ", "T")}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    text = `${text}T00:00:00Z`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The site's URLs, decoded and parsed, in definition order.
 *
 * The monitor stops at the first URL that answers; certificate checks want the
 * same preference order, but a host that is down is not a certificate answer,
 * so malformed entries are dropped here and the caller walks the rest.
 */
function parseSiteUrls(site) {
  const parsed = [];
  for (const raw of site.urls) {
    try {
      const url = new URL(decodeUrl(raw));
      parsed.push({
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        secure: url.protocol === "https:",
      });
    } catch {
      // Ignore an unparseable URL: it cannot be probed anyway.
    }
  }
  return parsed;
}

/**
 * Read the peer certificate of a TLS connection and return it as an ISO date.
 *
 * `rejectUnauthorized: false` is the point of the check, not a shortcut: an
 * expired or otherwise untrusted certificate still completes the handshake, so
 * the expiry date can be reported instead of the connection simply failing
 * with CERT_HAS_EXPIRED. Whether the chain actually verifies is reported
 * separately as `trustError`.
 */
function checkTls(host, port) {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResult(result);
    };

    const options = { host, port, rejectUnauthorized: false, timeout: TLS_TIMEOUT_MS };
    // SNI needs a name, not an address; IP-literal hosts are sent without it.
    if (!isIpAddress(host)) options.servername = host;

    const socket = tls.connect(options);

    socket.once("secureConnect", () => {
      let cert;
      try {
        cert = socket.getPeerCertificate();
      } catch (err) {
        return finish({ notAfter: null, issuer: null, trustError: null, error: `certificate read failed: ${err.message}` });
      }
      if (!cert || !cert.valid_to) {
        return finish({ notAfter: null, issuer: null, trustError: null, error: "no certificate presented" });
      }
      const notAfter = new Date(cert.valid_to);
      if (Number.isNaN(notAfter.getTime())) {
        return finish({ notAfter: null, issuer: null, trustError: null, error: `unparseable valid_to: ${cert.valid_to}` });
      }
      // `authorized` is false whenever the chain or the name does not verify —
      // the handshake still succeeded because verification was switched off.
      const trustError = socket.authorized ? null : String(socket.authorizationError || "not trusted");
      finish({
        notAfter: notAfter.toISOString(),
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        trustError,
        error: null,
      });
    });

    socket.once("timeout", () => finish({ notAfter: null, issuer: null, trustError: null, error: "ETIMEDOUT" }));
    socket.once("error", (err) => finish({ notAfter: null, issuer: null, trustError: null, error: err.code || err.message }));
  });
}

/** The `fn` value of an RDAP entity's jCard, which is where the name lives. */
function vcardName(entity) {
  const properties = entity?.vcardArray?.[1];
  if (!Array.isArray(properties)) return null;
  const fn = properties.find((p) => p[0] === "fn");
  return fn ? fn[3] : null;
}

/** Registrar name, looked for on nested entities because registries vary. */
function findRegistrar(entities) {
  // Not every registry fills these fields as the RFC describes them — one
  // returns `roles` as a bare string — so they are type-checked rather than
  // trusted, or a single odd record would abort the whole lookup.
  if (!Array.isArray(entities)) return null;
  for (const entity of entities) {
    const roles = Array.isArray(entity?.roles) ? entity.roles : [];
    if (roles.some((r) => String(r).toLowerCase() === "registrar")) {
      const name = vcardName(entity);
      if (name) return name;
    }
    const nested = findRegistrar(entity?.entities);
    if (nested) return nested;
  }
  return null;
}

/*
 * IANA's RDAP bootstrap: the authoritative TLD → registry endpoint map, fetched
 * once per run. `null` caches a failed fetch so every domain does not retry it.
 */
let rdapBasesPromise;

function loadRdapBases() {
  if (!rdapBasesPromise) {
    rdapBasesPromise = (async () => {
      // One blip here must not push every lookup of the run onto WHOIS, which
      // is slower and cannot answer for some of the TLDs RDAP can, so the
      // bootstrap is retried before the run degrades.
      let lastError;
      for (let attempt = 1; attempt <= RDAP_BOOTSTRAP_RETRIES; attempt++) {
        try {
          const response = await fetch(RDAP_BOOTSTRAP_URL, { headers: { "user-agent": USER_AGENT } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const bases = new Map();
          for (const [tlds, urls] of data.services ?? []) {
            for (const tld of tlds) bases.set(String(tld).toLowerCase(), urls[0]);
          }
          return bases;
        } catch (err) {
          lastError = err;
          if (attempt < RDAP_BOOTSTRAP_RETRIES) await sleep(RETRY_DELAY_MS);
        }
      }
      throw lastError;
    })().catch((err) => {
      console.warn(`[WARN] RDAP bootstrap unavailable: ${err.message} — every domain will go to WHOIS`);
      return null;
    });
  }
  return rdapBasesPromise;
}

/*
 * Circuit breaker for the whole run, set to the domain whose registry answered
 * HTTP 429 and read before every site is measured.
 *
 * A rate limit is a request to stop, not a per-domain hiccup, and carrying on
 * through the remaining sites would only deepen it — and turn one throttled
 * registry into a run where every later lookup fails too. Everything after the
 * first 429 keeps the reading it already had, so a throttled run still produces
 * a usable snapshot.
 */
let stoppedForThrottle = null;

/**
 * Expiry date and registrar for one registrable domain, via that TLD's RDAP
 * service.
 *
 * The event action is matched loosely: RFC 9083 says "expiration", but
 * registries also emit "Record expires" and similar wording.
 */
async function fetchRdapExpiry(domain, baseUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= RDAP_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);
      const response = await fetch(`${baseUrl}domain/${encodeURIComponent(domain)}`, {
        signal: controller.signal,
        redirect: "follow",
        headers: { accept: "application/rdap+json", "user-agent": USER_AGENT },
      });
      clearTimeout(timer);

      // A 404 is a fact about the domain, not a transient failure: the registry
      // answers RDAP for this TLD but has no record to give.
      if (response.status === 404) {
        return { expiresAt: null, registrar: null, error: "not found in RDAP" };
      }
      // 429 is the registry saying it has had enough. Backing off this one
      // lookup is pointless when the run is only a few lookups from over, so it
      // stops there and stops the run — see stoppedForThrottle. No retry, and
      // no WHOIS fallback either, which would be the same operator again.
      if (response.status === 429) {
        stoppedForThrottle = domain;
        return { expiresAt: null, registrar: null, error: "RDAP HTTP 429", throttled: true };
      }
      if (response.status === 503) {
        // Unavailable rather than rate-limited: wait as long as the registry
        // asks, this side of a cap, and try again.
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : RETRY_DELAY_MS;
        lastError = `RDAP HTTP ${response.status}`;
        if (attempt < RDAP_RETRIES) await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        lastError = `RDAP HTTP ${response.status}`;
      } else {
        const data = await response.json();
        const events = Array.isArray(data.events) ? data.events : [];
        const expiration = events.find((e) => /expir/i.test(e.eventAction ?? ""));
        if (!expiration?.eventDate) {
          return { expiresAt: null, registrar: null, error: "no expiration date in RDAP record" };
        }
        const expiresAt = parseRegistryDate(expiration.eventDate);
        if (!expiresAt) {
          return { expiresAt: null, registrar: null, error: `unparseable RDAP date: ${expiration.eventDate}` };
        }
        return { expiresAt, registrar: findRegistrar(data.entities), error: null };
      }
    } catch (err) {
      lastError = err.name === "AbortError" ? "ETIMEDOUT" : `${err.name}: ${err.message}`;
    }

    if (attempt < RDAP_RETRIES) await sleep(RETRY_DELAY_MS);
  }

  return { expiresAt: null, registrar: null, error: lastError ?? "RDAP lookup failed" };
}

/** One WHOIS query over port 43. Resolves with the raw response text. */
function whoisQuery(server, query) {
  return new Promise((resolveResult, rejectResult) => {
    const socket = net.connect({ host: server, port: 43 });
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectResult(new Error("ETIMEDOUT"));
    }, WHOIS_TIMEOUT_MS);

    socket.setEncoding("utf-8");
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => { clearTimeout(timer); resolveResult(text); });
    socket.on("error", (err) => { clearTimeout(timer); rejectResult(err); });
    socket.on("connect", () => socket.write(`${query}\r\n`));
  });
}

/** The registry's WHOIS server for a TLD, via the IANA referral. Cached. */
const whoisServerCache = new Map();
const whoisQueue = new PQueue({ concurrency: 1, interval: 1_200, intervalCap: 1 });

async function whoisServerFor(tld) {
  if (whoisServerCache.has(tld)) return whoisServerCache.get(tld);
  const server = await whoisQueue.add(async () => {
    try {
      const text = await whoisQuery(WHOIS_REFERRAL_HOST, tld);
      const match = text.match(/^whois:\s*(\S+)/im);
      return match ? match[1] : null;
    } catch (err) {
      console.warn(`[WARN] WHOIS referral for .${tld} failed: ${err.code || err.message}`);
      return null;
    }
  });
  whoisServerCache.set(tld, server);
  return server;
}

/** Expiry date and registrar from a registry's WHOIS record. */
async function fetchWhoisExpiry(domain) {
  const tld = domain.split(".").pop();
  const server = await whoisServerFor(tld);
  if (!server) {
    return { expiresAt: null, registrar: null, error: "no RDAP or WHOIS service for this TLD" };
  }

  try {
    // Serialised through one queue at just over a second per query: registry
    // WHOIS servers throttle and then block bulk querying from one address.
    const text = await whoisQueue.add(() =>
      whoisQuery(server, `${WHOIS_QUERY_PREFIX[tld] ?? ""}${domain}`)
    );

    let expiresAt = null;
    for (const pattern of WHOIS_EXPIRY_PATTERNS) {
      const match = text.match(pattern);
      if (match) { expiresAt = parseRegistryDate(match[1]); break; }
    }
    let registrar = null;
    for (const pattern of WHOIS_REGISTRAR_PATTERNS) {
      const match = text.match(pattern);
      if (match) { registrar = match[1].trim(); break; }
    }

    if (!expiresAt) {
      return { expiresAt: null, registrar, error: "no expiration date in WHOIS record" };
    }
    return { expiresAt, registrar, error: null };
  } catch (err) {
    return { expiresAt: null, registrar: null, error: `WHOIS ${err.code || err.message}` };
  }
}

/**
 * Expiry date and registrar for one registrable domain.
 *
 * RDAP first where the TLD publishes it, then WHOIS — a second chance for the
 * TLDs that publish neither (among them .cn, .me, .de) as well as for a
 * registry whose RDAP endpoint fails on the day.
 *
 * The domain itself is the caller's lookup key and is deliberately not part of
 * the result: the snapshot is written per site id and carries no hostnames.
 */
async function fetchDomainExpiry(domain) {
  const bases = await loadRdapBases();
  const baseUrl = bases?.get(domain.split(".").pop());

  let rdapError = null;
  if (baseUrl) {
    const result = await fetchRdapExpiry(domain, baseUrl);
    if (result.expiresAt) return result;
    // A registry that answered 429 is not asked again over WHOIS: it is the
    // same operator being asked the same question, and the run is stopping.
    if (result.throttled) return { expiresAt: null, registrar: null, error: result.error };
    rdapError = result.error;
  }

  const whois = await fetchWhoisExpiry(domain);
  if (whois.expiresAt) return whois;

  // Both protocols were tried when there was an RDAP service to try; say so,
  // so a missing date reads as "we asked and got nothing" rather than silence.
  const error = rdapError ? `${rdapError} / ${whois.error}` : whois.error;
  return { expiresAt: null, registrar: whois.registrar, error };
}

/** Whole days from now until an ISO date; null when it cannot be read. */
function daysLeft(date, now) {
  const time = new Date(date).getTime();
  return Number.isNaN(time) ? null : Math.floor((time - now) / 86_400_000);
}

/**
 * The previous snapshot keyed by site id, or an empty object when there is none
 * or it cannot be read — in which case everything is simply measured again.
 */
function loadPreviousSnapshot() {
  if (!existsSync(OUTPUT_FILE)) return {};
  try {
    const previous = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
    const sites = previous?.sites;
    return sites && typeof sites === "object" && !Array.isArray(sites) ? sites : {};
  } catch {
    return {};
  }
}

/**
 * Whether a stored field still stands, or has to be measured again.
 *
 * Re-measured when there is nothing stored, when the last attempt failed or the
 * certificate did not verify (retrying is what a later run is for, and an
 * anomaly should be seen to clear), when the stored value came from a run that
 * did not date itself and so cannot be judged for age, when the reading is
 * older than RECHECK_AFTER_DAYS, or when the expiry is now within
 * RECHECK_WITHIN_DAYS.
 */
function needsCheck(previous, dateKey, now) {
  if (!previous?.checkedAt) return true;
  if (previous.error || previous.trustError) return true;

  // Age is judged in milliseconds rather than by counting whole days, which
  // rounds the wrong way for a timestamp in the past.
  const checked = new Date(previous.checkedAt).getTime();
  if (Number.isNaN(checked) || now - checked >= RECHECK_AFTER_DAYS * 86_400_000) return true;

  const date = previous[dateKey];
  if (!date) return true;
  const left = daysLeft(date, now);
  return left === null || left <= RECHECK_WITHIN_DAYS;
}

async function main() {
  console.log("[INFO] Starting certificate & domain expiry check...");

  if (!existsSync(SOURCE_FILE)) {
    console.error(`[ERROR] Source file not found: ${SOURCE_FILE}`);
    console.error("[ERROR] Run `node scripts/update-source.mjs` first.");
    process.exit(1);
  }

  const sites = JSON.parse(readFileSync(SOURCE_FILE, "utf-8"));
  const activeSites = sites.filter((s) => !s.isDead);
  console.log(`[INFO] Loaded ${sites.length} sites, checking ${activeSites.length} active site(s)`);

  // The snapshot being replaced, which decides what this run actually has to
  // measure. Read before the run starts, since the run overwrites the file.
  const previousSites = loadPreviousSnapshot();
  // One instant for the whole run: a value measured now is stamped with it, so
  // "checked at" and the snapshot's own timestamp are the same clock.
  const timestamp = new Date().toISOString();

  // One lookup per registrable domain: a site's mirror URLs and the many sites
  // sharing a registry each ask the same question.
  const domainCache = new Map();

  async function domainExpiryFor(domain) {
    let pending = domainCache.get(domain);
    if (!pending) {
      pending = fetchDomainExpiry(domain);
      domainCache.set(domain, pending);
    }
    return pending;
  }

  const queue = new PQueue({ concurrency: CONCURRENCY });
  // Keyed by site id, like request-overrides.json, rather than a list of
  // entries: the id is then written once, in the key, instead of in every
  // record, and a reader looks a site up instead of scanning for it.
  const results = {};
  const counters = { sslChecked: 0, sslCarried: 0, domainChecked: 0, domainCarried: 0 };
  // Sites the breaker stopped before they were looked at.
  let skipped = 0;

  await queue.addAll(
    activeSites.map((site) => async () => {
      const urls = parseSiteUrls(site);
      const httpsUrls = urls.filter((u) => u.secure);
      const previous = previousSites[site.id];
      const now = Date.now();
      const lines = [`[TEST] ${site.id} (${site.name}) — ${urls.length} URL(s)`];

      // The registries are throttling: everything still to come keeps what the
      // previous snapshot knew, and a site it never knew about is left out
      // rather than written as a failure. Checked here rather than mid-task, so
      // a lookup that started just before the breaker stays a whole answer.
      if (stoppedForThrottle) {
        skipped++;
        if (previous) results[site.id] = previous;
        return;
      }

      // Certificate: walk the HTTPS URLs in order and take the first host that
      // presents one, exactly as the monitor takes the first that answers. The
      // host is named in the log line only; the snapshot records no hostnames.
      let ssl;
      if (!needsCheck(previous?.ssl, "notAfter", now)) {
        ssl = previous.ssl;
        counters.sslCarried++;
        lines.push(`  = certificate carried — ${daysLeft(ssl.notAfter, now)} days left, read ${ssl.checkedAt.slice(0, 10)}`);
      } else {
        counters.sslChecked++;
        ssl = {
          notAfter: null,
          issuer: null,
          trustError: null,
          error: httpsUrls.length === 0 ? (urls.length === 0 ? "no URL to check" : "no HTTPS URL") : null,
        };
        for (const { host, port } of httpsUrls) {
          const check = await checkTls(host, port);
          lines.push(
            `  ${check.error ? "✗" : "✓"} ${host}:${port} — ${check.error ?? `${check.notAfter} (${check.issuer ?? "unknown issuer"})`}`
          );
          ssl = check;
          if (!check.error) break;
        }
        ssl.checkedAt = timestamp;
      }

      // Domain: the site's own address, so the first HTTPS URL if there is one
      // and otherwise the first URL at all. Reachability is not part of the
      // question — a domain can expire while its host is unreachable.
      const domainUrl = httpsUrls[0] ?? urls[0] ?? null;
      let domain;
      if (!needsCheck(previous?.domain, "expiresAt", now)) {
        domain = previous.domain;
        counters.domainCarried++;
        lines.push(`  = domain carried — ${daysLeft(domain.expiresAt, now)} days left, read ${domain.checkedAt.slice(0, 10)}`);
      } else {
        counters.domainChecked++;
        if (domainUrl && !isIpAddress(domainUrl.host)) {
          const registrable = registrableDomain(domainUrl.host);
          domain = await domainExpiryFor(registrable);
          lines.push(
            `  ${domain.error ? "✗" : "✓"} ${registrable} — ${domain.error ?? `${domain.expiresAt}${domain.registrar ? ` (${domain.registrar})` : ""}`}`
          );
        } else {
          const error = domainUrl ? "host is an IP address" : "no URL to check";
          domain = { expiresAt: null, registrar: null, error };
          lines.push(`  ✗ domain — ${error}`);
        }
        domain.checkedAt = timestamp;
      }

      results[site.id] = { ssl, domain };
      // One console.log per site = atomic output, no interleaving.
      console.log(lines.join("\n") + "\n");
    })
  );

  const output = { timestamp, sites: results };
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  const checked = Object.values(results);
  const sslOk = checked.filter((r) => r.ssl?.notAfter).length;
  const domainOk = checked.filter((r) => r.domain?.expiresAt).length;
  console.log(
    `[DONE] SSL: ${sslOk}/${checked.length} dated (${counters.sslChecked} checked, ${counters.sslCarried} carried) | ` +
      `Domain: ${domainOk}/${checked.length} dated (${counters.domainChecked} checked, ${counters.domainCarried} carried) ` +
      `— Saved to ${OUTPUT_FILE}`
  );

  if (stoppedForThrottle) {
    // Worth a line rather than a silent short run: the entries left out keep an
    // older `checkedAt`, and the next run is what catches them up.
    console.warn(
      `[THROTTLED] ${stoppedForThrottle} answered HTTP 429 — stopped there, ` +
        `${skipped} site(s) after it kept their previous reading`
    );
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
