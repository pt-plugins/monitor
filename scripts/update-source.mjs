// scripts/update-source.mjs
// Fetches site definitions from PT-depiler and extracts siteMetadata into data/site.json

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = join(ROOT, ".cache", "pt-depiler");
const SOURCE_FILE = join(ROOT, "data", "site.json");
const REPO_URL = "https://github.com/pt-plugins/PT-depiler.git";

// Recursively find all .ts files in a directory
function findTsFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

// Extract siteMetadata from a TypeScript file using regex
function extractSiteMetadata(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");

    // Find the siteMetadata variable declaration
    // Matches: export const siteMetadata = { ... } or export const siteMetadata: SiteMetadata = { ... }
    const metaRegex =
      /export\s+const\s+siteMetadata\s*(?::\s*\w+)?\s*=\s*\{([\s\S]*?)\};/;
    const match = content.match(metaRegex);
    if (!match) {
      console.warn(`[WARN] No siteMetadata found in ${filePath}`);
      return null;
    }

    const body = match[1];

    // Extract individual fields
    const extractStr = (field) => {
      const re = new RegExp(`${field}\\s*:\\s*['"]([^'"]*)['"]`);
      const m = body.match(re);
      return m ? m[1] : "";
    };

    const extractBool = (field) => {
      const re = new RegExp(`${field}\\s*:\\s*(true|false)`);
      const m = body.match(re);
      return m ? m[1] === "true" : null;
    };

    // Extract urls array: urls: ['...', "..."], stored raw (ROT13 decoded at runtime)
    const extractUrls = () => {
      const urlsMatch = body.match(/urls\s*:\s*\[([\s\S]*?)\]/);
      if (!urlsMatch) return [];

      const urlsBlock = urlsMatch[1];
      const urls = [];
      const urlRegex = /['"]([^'"]*)['"]/g;
      let m;
      while ((m = urlRegex.exec(urlsBlock)) !== null) {
        urls.push(m[1]);
      }
      return urls;
    };

    const id = extractStr("id");
    if (!id) {
      console.warn(`[WARN] No id found in ${filePath}, skipping`);
      return null;
    }

    const isDeadRaw = extractBool("isDead");

    return {
      id,
      name: extractStr("name"),
      urls: extractUrls(),
      type: extractStr("type"),
      description: extractStr("description"),
      favicon: extractStr("favicon"),
      isDead: isDeadRaw !== null ? isDeadRaw : false,
    };
  } catch (err) {
    console.warn(`[WARN] Error parsing ${filePath}: ${err.message}`);
    return null;
  }
}

// Clone or update the PT-depiler repo
function syncRepo() {
  if (!existsSync(dirname(CACHE_DIR))) {
    mkdirSync(dirname(CACHE_DIR), { recursive: true });
  }

  if (existsSync(join(CACHE_DIR, ".git"))) {
    console.log("[INFO] Updating existing PT-depiler clone...");
    execSync("git fetch --depth=1 origin master", { cwd: CACHE_DIR, stdio: "inherit" });
    execSync("git reset --hard origin/master", { cwd: CACHE_DIR, stdio: "inherit" });
  } else {
    console.log("[INFO] Cloning PT-depiler (shallow)...");
    mkdirSync(CACHE_DIR, { recursive: true });
    execSync(`git clone --depth=1 --branch=master ${REPO_URL} "${CACHE_DIR}"`, {
      stdio: "inherit",
    });
  }
}

// Main
function main() {
  console.log("[INFO] Starting site source update...");

  // Step 1: Sync repo
  syncRepo();

  // Step 2: Find all definition .ts files
  const defsDir = join(
    CACHE_DIR,
    "src",
    "packages",
    "site",
    "definitions"
  );

  if (!existsSync(defsDir)) {
    console.error(`[ERROR] Definitions directory not found: ${defsDir}`);
    process.exit(1);
  }

  const tsFiles = findTsFiles(defsDir);
  console.log(`[INFO] Found ${tsFiles.length} .ts files`);

  // Step 3: Extract siteMetadata from each file
  const sites = [];
  for (const file of tsFiles) {
    const meta = extractSiteMetadata(file);
    if (meta) {
      console.log(`[OK] ${meta.id} (${meta.name}) — ${meta.urls.length} URLs${meta.isDead ? " [DEAD]" : ""}`);
      sites.push(meta);
    }
  }

  // Step 4: Write to data/site.json
  const dataDir = dirname(SOURCE_FILE);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  writeFileSync(SOURCE_FILE, JSON.stringify(sites, null, 2), "utf-8");
  console.log(`[INFO] Written ${sites.length} sites to ${SOURCE_FILE}`);

  // Step 5: Copy site icons from PT-depiler to public/siteIcons/
  const cacheIconsDir = join(CACHE_DIR, "public", "icons", "site");
  const targetIconsDir = join(ROOT, "public", "siteIcons");
  if (existsSync(cacheIconsDir)) {
    mkdirSync(targetIconsDir, { recursive: true });
    const iconFiles = readdirSync(cacheIconsDir);
    let copied = 0;
    for (const f of iconFiles) {
      const src = join(cacheIconsDir, f);
      const dst = join(targetIconsDir, f);
      if (statSync(src).isFile()) {
        writeFileSync(dst, readFileSync(src));
        copied++;
      }
    }
    console.log(`[INFO] Copied ${copied} site icons to ${targetIconsDir}`);
  }
}

main();
