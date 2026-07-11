// scripts/monitor.mjs
// Reads data/site.json, tests each site's URLs, writes results to data/uptime/YYYY/MM/DD/HH_MM.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PQueue from "p-queue";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const UPTIME_DIR = join(DATA_DIR, "uptime");
const SOURCE_FILE = join(DATA_DIR, "site.json");

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

// ROT13 decode: each alphabetic char shifted by 13, preserving case
function rot13(str) {
  return str.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// Decode a URL if it looks rot13-encoded (starts with uggcf:// or uggc://)
function decodeUrl(str) {
  return /^uggcf?:\/\//i.test(str) ? rot13(str) : str;
}

// Sleep helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Check if response is from Cloudflare WAF (site is protected but reachable)
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

// Test a URL with Playwright (headless browser) — fallback for non-Cloudflare 403
async function probeUrlWithPlaywright(url) {
  const logs = [];
  const start = Date.now();
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Track the main request response status
    let mainResponse = null;
    page.on("response", (res) => {
      const reqUrl = res.url().replace(/\/$/, "");
      const targetUrl = url.replace(/\/$/, "");
      if (reqUrl === targetUrl) {
        mainResponse = res;
      }
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: REQUEST_TIMEOUT_MS });
    const latency = Date.now() - start;

    const title = await page.title();
    await browser.close();

    // If the main response is ok (2xx / 3xx), treat as up
    if (mainResponse && (mainResponse.ok() || (mainResponse.status() >= 300 && mainResponse.status() < 400))) {
      logs.push(`    [playwright] HTTP ${mainResponse.status()} — "${title}" (${latency}ms)`);
      return { status: "up", latency, logs };
    }

    // If page has a meaningful title and no error, treat as up too
    if (title && title.length > 0 && !title.toLowerCase().includes("403") && !title.toLowerCase().includes("forbidden")) {
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
  }
}

// Test a single URL with retry logic — falls back to Playwright on non-Cloudflare 403
async function probeUrl(url, retries = MAX_RETRIES) {
  const logs = [];
  let hasNonCloudflare403 = false;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "PTD-Monitor/1.0" },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latency = Date.now() - start;

      if (response.ok || (response.status >= 300 && response.status < 400)) {
        return { status: "up", latency, logs };
      }

      // Treat Cloudflare WAF as reachable
      if (isCloudflareWAF(response)) {
        logs.push(`    [${attempt}/${retries}] HTTP ${response.status} Cloudflare WAF (${latency}ms)`);
        return { status: "up", latency, logs };
      }

      // Track non-Cloudflare 403 for Playwright fallback
      if (isNonCloudflare403(response)) {
        hasNonCloudflare403 = true;
        logs.push(`    [${attempt}/${retries}] HTTP ${response.status} non-Cloudflare 403 (${latency}ms)`);
      } else {
        logs.push(`    [${attempt}/${retries}] HTTP ${response.status} (${latency}ms)`);
      }
    } catch (err) {
      const latency = Date.now() - start;
      const errorMsg = err.name === "AbortError" ? "ETIMEDOUT" : err.message;
      logs.push(`    [${attempt}/${retries}] ${errorMsg} (${latency}ms)`);
    }

    if (attempt < retries) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  // If any attempt got a non-Cloudflare 403, fall back to Playwright
  if (hasNonCloudflare403) {
    logs.push(`  → Fetch retries exhausted with non-Cloudflare 403, retrying with Playwright...`);
    const pwResult = await probeUrlWithPlaywright(url);
    logs.push(...pwResult.logs);
    if (pwResult.status === "up") {
      return { status: "up", latency: pwResult.latency, logs };
    }
  }

  return { status: "down", latency: null, error: "All retries exhausted", logs };
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

  // Step 2: Filter out dead sites
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
      for (const rawUrl of site.urls) {
        const url = decodeUrl(rawUrl);
        const { logs: attemptLogs, ...urlResult } = await probeUrl(url);
        lines.push(...attemptLogs);
        if (urlResult.status === "up") {
          siteStatus = "up";
          siteLatency = urlResult.latency;
          lines.push(`  ✓ ${url} — ${urlResult.latency}ms`);
          break;
        } else {
          lines.push(`  ✗ ${url} — FAILED`);
        }
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
  const downCount = siteResults.filter((s) => s.status === "down").length;

  console.log(
    `[DONE] UP: ${upCount}, DOWN: ${downCount}, DEAD: ${deadCount} — Saved to ${outFile}`
  );
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
