// scripts/monitor.mjs
// Reads data/site.json, tests each site's URLs, writes results to data/uptime/YYYY/MM/DD/HH_MM.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PQueue from "p-queue";
import { decodeUrl } from "../src/lib/site-url.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const UPTIME_DIR = join(DATA_DIR, "uptime");
const SOURCE_FILE = join(DATA_DIR, "site.json");

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const OVERRIDES_FILE = join(DATA_DIR, "request-overrides.json");

// Sleep helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Describe a failed fetch in one line, keeping the cause undici attaches to it.
// fetch() itself only ever reports "fetch failed"; the cause carries the code
// (UND_ERR_CONNECT_TIMEOUT, ENOTFOUND, ECONNRESET, ...) and, for connect
// failures, the addresses that were tried — the part that tells a network-level
// block apart from a DNS or TLS problem.
function describeFetchError(err) {
  if (err.name === "AbortError") {
    return "ETIMEDOUT — aborted by the monitor's own timeout";
  }
  const cause = err.cause;
  if (!cause) return err.message;
  const code = cause.code || cause.name || "unknown cause";
  const detail = typeof cause.message === "string" ? cause.message.trim() : "";
  return detail ? `${err.message}: ${code} — ${detail}` : `${err.message}: ${code}`;
}

// Check if a fetch response was answered by Cloudflare's WAF instead of the
// origin. It is a hint that the probe has to look again, never an "up" answer:
// a challenge page proves Cloudflare is reachable, not that the site behind it
// is.
function isCloudflareWAF(response) {
  const server = (response.headers.get("server") || "").toLowerCase();
  const cfRay = response.headers.get("cf-ray");
  // Cloudflare typically returns 403 or 503 with cf-ray header
  return (response.status === 403 || response.status === 503) && (server.includes("cloudflare") || cfRay);
}

// Check if response is a non-Cloudflare 403 (site blocking direct fetch)
function isNonCloudflare403(response) {
  return response.status === 403 && !isCloudflareWAF(response);
}

// Wording Cloudflare puts on its own interstitials: the challenge ("Just a
// moment...", "Verify you are human") and the block page ("Sorry, you have been
// blocked"). Titles are the sharper signal; the source markers also have to
// match a 403/503, because a site can legitimately embed a Turnstile widget.
const CF_TITLE_MARKERS = [
  "just a moment",
  "attention required",
  "checking your browser",
  "verify you are human",
  "you have been blocked",
  // Cloudflare localises the interstitial; the probe meets these on zh sites.
  "请稍候",
  "验证您是人类",
  "检查浏览器",
  "正在进行安全验证",
];
const CF_SOURCE_MARKERS = ["cdn-cgi/challenge-platform", "__cf_chl", "cf-browser-verification"];

// Time a challenge page gets to reload on its own — a managed challenge solves
// itself and navigates again — before the probe calls the site unobserved.
const CHALLENGE_GRACE_MS = 5_000;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Same origin and path, ignoring the query: a challenge reload carries a
// `__cf_chl_tk` token the probe URL does not have.
function samePage(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "")
    );
  } catch {
    return a === b;
  }
}

// The title and the first few kilobytes of source, which together say whether
// what loaded is the site or Cloudflare speaking for it.
async function snapshotPage(page) {
  const title = await page.title().catch(() => "");
  const source = await page
    .evaluate(() => (document.documentElement?.outerHTML ?? "").slice(0, 4_000))
    .catch(() => "");
  return { title, source };
}

// True when Playwright is looking at Cloudflare's interstitial rather than the
// site. `cf-mitigated` is Cloudflare's own marker that it authored the
// response; cf-ray alone is not, since every proxied origin response has one.
function isCloudflareInterstitial(response, snapshot) {
  const mitigated = response ? response.headers()["cf-mitigated"] || "" : "";
  if (mitigated) return true;

  const title = snapshot.title.toLowerCase();
  if (CF_TITLE_MARKERS.some((marker) => title.includes(marker))) return true;

  const status = response ? response.status() : 0;
  return (
    (status === 403 || status === 503) &&
    CF_SOURCE_MARKERS.some((marker) => snapshot.source.toLowerCase().includes(marker))
  );
}

// Re-check a URL in a real browser: the fallback for non-Cloudflare 403s, and
// the only way a Cloudflare WAF response can still count as "up" — the
// challenge has to clear and the page behind it has to load. A challenge that
// never clears leaves the origin unobserved; this function reports that as a
// failed probe, and probeUrl records it as "blocked" rather than as an outage.
async function probeUrlWithPlaywright(url) {
  const logs = [];
  const start = Date.now();
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_USER_AGENT, locale: "en-US" });
    const page = await context.newPage();

    // Track the main request's response.
    let mainResponse = null;
    page.on("response", (res) => {
      if (samePage(res.url(), url)) mainResponse = res;
    });

    // "load" rather than "networkidle": a challenge page keeps polling
    // /cdn-cgi/challenge-platform and never goes idle, so waiting for idle
    // would time out on exactly the pages this fallback exists to judge.
    await page.goto(url, { waitUntil: "load", timeout: REQUEST_TIMEOUT_MS });

    let snapshot = await snapshotPage(page);
    if (isCloudflareInterstitial(mainResponse, snapshot)) {
      logs.push(`    [playwright] Cloudflare interstitial — waiting ${CHALLENGE_GRACE_MS / 1000}s for it to clear`);
      await page.waitForTimeout(CHALLENGE_GRACE_MS);
      snapshot = await snapshotPage(page);
    }
    // Measured to the last check, so a challenge that clears carries the grace
    // period in its latency: what is reported is when the probe could see the
    // page, which is the only figure this path can honestly produce.
    const latency = Date.now() - start;

    // Still an interstitial after the grace period: the page behind it was
    // never seen, so this is not an up, however healthy the site may be.
    if (isCloudflareInterstitial(mainResponse, snapshot)) {
      logs.push(`    [playwright] Cloudflare challenge not passed — "${snapshot.title}" (${latency}ms)`);
      return { status: "down", latency: null, error: "Cloudflare WAF challenge not passed", logs };
    }

    // If the main response is ok (2xx / 3xx), treat as up
    if (mainResponse && (mainResponse.ok() || (mainResponse.status() >= 300 && mainResponse.status() < 400))) {
      logs.push(`    [playwright] HTTP ${mainResponse.status()} — "${snapshot.title}" (${latency}ms)`);
      return { status: "up", latency, logs };
    }

    // If page has a meaningful title and no error, treat as up too
    const title = snapshot.title.trim();
    if (title && !/403|forbidden/i.test(title)) {
      logs.push(`    [playwright] loaded — "${title}" (${latency}ms)`);
      return { status: "up", latency, logs };
    }

    const statusCode = mainResponse ? mainResponse.status() : "?";
    logs.push(`    [playwright] HTTP ${statusCode} — "${title}" (${latency}ms)`);
    return { status: "down", latency: null, error: "Playwright probe failed", logs };
  } catch (err) {
    const latency = Date.now() - start;
    const errorMsg = err.name === "TimeoutError" ? "ETIMEDOUT" : err.message;
    logs.push(`    [playwright] ${errorMsg} (${latency}ms)`);
    return { status: "down", latency: null, error: errorMsg, logs };
  } finally {
    await browser?.close().catch(() => {});
  }
}

// Apply request overrides to a URL and return merged fetch options
function applyOverrides(rawUrl, overrides) {
  let url = rawUrl;
  const fetchOptions = {
    method: "GET",
    headers: { "User-Agent": "PTD-Monitor/1.0" },
    redirect: "follow",
  };

  if (!overrides) return { url, fetchOptions };

  // Override HTTP method
  if (overrides.method) {
    fetchOptions.method = overrides.method.toUpperCase();
  }

  // Override URL path: replace the path component
  if (overrides.path) {
    try {
      const parsed = new URL(url);
      // Normalise the path: ensure it starts with /
      const newPath = overrides.path.startsWith("/") ? overrides.path : `/${overrides.path}`;
      parsed.pathname = newPath;
      url = parsed.toString();
    } catch {
      // If URL parsing fails, ignore path override
    }
  }

  // Merge extra headers
  if (overrides.headers && typeof overrides.headers === "object") {
    fetchOptions.headers = { ...fetchOptions.headers, ...overrides.headers };
  }

  // Request body (for POST/PUT etc.)
  if (overrides.body !== undefined) {
    fetchOptions.body = overrides.body;
  }

  return { url, fetchOptions };
}

// Test a single URL with retry logic — falls back to Playwright when the answer
// came from something other than the site (non-Cloudflare 403, Cloudflare WAF).
async function probeUrl(url, retries = MAX_RETRIES, overrides = null) {
  const logs = [];
  let needsBrowser = false;
  let sawWaf = false;
  let lastError = null;

  // Apply overrides to get the effective URL and fetch options
  const { url: effectiveUrl, fetchOptions } = applyOverrides(url, overrides);
  const timeoutMs = overrides?.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // Overrides rewrite the URL and/or the method, so log the request that is
  // actually sent; the site's own URL alone no longer describes the probe.
  if (effectiveUrl !== url || fetchOptions.method !== "GET") {
    logs.push(`    [info] request overrides applied → ${fetchOptions.method} ${effectiveUrl}`);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(effectiveUrl, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latency = Date.now() - start;

      if (response.ok || (response.status >= 300 && response.status < 400)) {
        return { status: "up", latency, logs };
      }

      const httpStatus = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

      // A Cloudflare challenge is not an answer from the site, so it cannot be
      // up on its own. Retrying the same fetch only earns the same challenge —
      // Cloudflare scores the request, not the attempt — so hand this one to
      // Playwright right away and let the page decide.
      if (isCloudflareWAF(response)) {
        needsBrowser = true;
        sawWaf = true;
        lastError = `${httpStatus} (Cloudflare WAF)`;
        logs.push(`    [${attempt}/${retries}] ${httpStatus} Cloudflare WAF — origin not observed (${latency}ms)`);
        break;
      }

      // Track non-Cloudflare 403 for Playwright fallback
      if (isNonCloudflare403(response)) {
        needsBrowser = true;
        lastError = `${httpStatus} (non-Cloudflare)`;
        logs.push(`    [${attempt}/${retries}] ${httpStatus} non-Cloudflare 403 (${latency}ms)`);
      } else {
        lastError = httpStatus;
        logs.push(`    [${attempt}/${retries}] ${httpStatus} (${latency}ms)`);
      }
    } catch (err) {
      const latency = Date.now() - start;
      lastError = describeFetchError(err);
      logs.push(`    [${attempt}/${retries}] ${lastError} (${latency}ms)`);
    }

    if (attempt < retries) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  // If any attempt was answered by something other than the site, re-check it
  // in a browser. For a Cloudflare WAF response this is the decisive step: a
  // page that loads behind the challenge makes the check up; one that does not
  // was never observed, which is recorded as its own status rather than as an
  // outage — see the note on "blocked" in README.
  if (needsBrowser) {
    logs.push(
      sawWaf
        ? `  → Cloudflare WAF in the way, re-checking with Playwright...`
        : `  → Fetch retries exhausted with non-Cloudflare 403, retrying with Playwright...`
    );
    const pwResult = await probeUrlWithPlaywright(effectiveUrl);
    logs.push(...pwResult.logs);
    if (pwResult.status === "up") {
      return { status: "up", latency: pwResult.latency, logs };
    }
    if (sawWaf) {
      return {
        status: "blocked",
        latency: null,
        error: `Cloudflare WAF: ${pwResult.error || "challenge not passed"}`,
        logs,
      };
    }
    lastError = `Playwright fallback: ${pwResult.error || "failed"}`;
  }

  return { status: "down", latency: null, error: lastError ?? "All retries exhausted", logs };
}

// Get current datetime parts for file path
function getNowParts() {
  const now = new Date();
  const YYYY = String(now.getFullYear());
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return { YYYY, MM, DD, HH, mm };
}

// Main
async function main() {
  console.log("[INFO] Starting uptime monitor...");

  // Step 1: Read site definitions
  if (!existsSync(SOURCE_FILE)) {
    console.error(`[ERROR] Source file not found: ${SOURCE_FILE}`);
    console.error("[ERROR] Run `node scripts/update-source.mjs` first.");
    process.exit(1);
  }

  const sites = JSON.parse(readFileSync(SOURCE_FILE, "utf-8"));
  console.log(`[INFO] Loaded ${sites.length} sites from source`);

  // Step 2: Load per-site request overrides (optional)
  let requestOverrides = {};
  if (existsSync(OVERRIDES_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8"));
      requestOverrides = raw.sites || {};
      const overrideCount = Object.keys(requestOverrides).length;
      if (overrideCount > 0) {
        console.log(`[INFO] Loaded request overrides for ${overrideCount} site(s)`);
      }
    } catch (err) {
      console.warn(`[WARN] Failed to parse ${OVERRIDES_FILE}: ${err.message}. Continuing without overrides.`);
    }
  }

  // Step 3: Filter out dead sites
  const activeSites = sites.filter((s) => !s.isDead);
  const deadCount = sites.length - activeSites.length;
  if (deadCount > 0) {
    console.log(`[INFO] Skipping ${deadCount} dead site(s)`);
  }

  // Step 3: Probe each site with p-queue; print atomically as each site finishes
  const queue = new PQueue({ concurrency: 5 });
  const timestamp = new Date().toISOString();
  const siteResults = [];

  await queue.addAll(
    activeSites.map((site) => async () => {
      const lines = [`[TEST] ${site.id} (${site.name}) — ${site.urls.length} URL(s)`];

      let siteLatency = null;
      let siteStatus = "down";
      let sawBlockedUrl = false;
      for (const rawUrl of site.urls) {
        const url = decodeUrl(rawUrl);
        const siteOverride = requestOverrides[site.id] || null;
        const { logs: attemptLogs, ...urlResult } = await probeUrl(url, MAX_RETRIES, siteOverride);
        lines.push(...attemptLogs);
        if (urlResult.status === "up") {
          siteStatus = "up";
          siteLatency = urlResult.latency;
          lines.push(`  ✓ ${url} — ${urlResult.latency}ms`);
          break;
        }
        // A WAF that answered for the site is not an outage; it outranks a
        // plain failure, but any URL that loads still makes the site up.
        if (urlResult.status === "blocked") {
          sawBlockedUrl = true;
          lines.push(`  ~ ${url} — BLOCKED: ${urlResult.error}`);
        } else {
          lines.push(`  ✗ ${url} — FAILED: ${urlResult.error}`);
        }
      }
      if (siteStatus === "down" && sawBlockedUrl) {
        siteStatus = "blocked";
      }

      const result = {
        id: site.id,
        status: siteStatus,
        latency: siteLatency,
      };

      // One console.log per site = atomic output, no interleaving
      console.log(lines.join("\n") + "\n");

      siteResults.push(result);
      return result;
    })
  );

  // Step 4: Write results to data/uptime/YYYY/MM/DD/HH_MM.json
  const { YYYY, MM, DD, HH, mm } = getNowParts();
  const outDir = join(UPTIME_DIR, YYYY, MM, DD);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const outFile = join(outDir, `${HH}_${mm}.json`);
  const output = {
    timestamp,
    sites: siteResults,
  };

  writeFileSync(outFile, JSON.stringify(output, null, 2), "utf-8");

  const upCount = siteResults.filter((s) => s.status === "up").length;
  const blockedCount = siteResults.filter((s) => s.status === "blocked").length;
  const downCount = siteResults.filter((s) => s.status === "down").length;

  console.log(
    `[DONE] UP: ${upCount}, BLOCKED: ${blockedCount}, DOWN: ${downCount}, DEAD: ${deadCount} — Saved to ${outFile}`
  );
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
