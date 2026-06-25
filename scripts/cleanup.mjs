// scripts/cleanup.mjs
// Processes all non-today daily data and non-current-month monthly data.
// Merges raw HH_MM.json files → DD.json, then DD.json → MM.json (JSONLines).
// Generates data/uptime.json as an index of all merged files.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const UPTIME_DIR = join(DATA_DIR, "uptime");
const INDEX_FILE = join(DATA_DIR, "uptime.json");

// Get today and this month identifiers
function getToday() {
  const d = new Date();
  const Y = String(d.getFullYear());
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  return { dateStr: `${Y}-${M}-${D}`, Y, M, D };
}

function getThisMonth() {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Merge daily per-run files into a single JSONLines file
// Returns number of runs merged, or -1 if skipped
function mergeDaily(year, month, day) {
  const dayDir = join(UPTIME_DIR, year, month, day);
  const dateStr = `${year}-${month}-${day}`;
  const outFile = join(UPTIME_DIR, year, month, `${day}.jsonl`);

  if (!existsSync(dayDir) || !statSync(dayDir).isDirectory()) {
    return -1; // not a raw directory
  }

  const files = readdirSync(dayDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    // Empty dir — try to remove
    try { rmdirSync(dayDir); } catch {}
    return -1;
  }

  // If outFile already exists (previous merge), append new runs
  const existing = new Set();
  if (existsSync(outFile)) {
    const old = readFileSync(outFile, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of old) {
      try {
        const ts = JSON.parse(line).timestamp;
        if (ts) existing.add(ts);
      } catch {}
    }
  }

  const lines = [];
  let newCount = 0;
  for (const file of files) {
    try {
      const content = readFileSync(join(dayDir, file), "utf-8");
      const data = JSON.parse(content);
      const ts = data.timestamp;
      // Skip duplicates by timestamp
      if (ts && existing.has(ts)) continue;
      if (ts) existing.add(ts);
      lines.push(JSON.stringify(data));
      newCount++;
    } catch (err) {
      console.warn(`[WARN] Failed to read ${file}: ${err.message}`);
    }
  }

  if (lines.length === 0) {
    console.log(`[SKIP] ${dateStr} — no new runs to merge`);
    // Clean up raw files anyway
    for (const file of files) unlinkSync(join(dayDir, file));
    try { rmdirSync(dayDir); } catch {}
    return 0;
  }

  // Write (append if file exists)
  const mode = existsSync(outFile) ? "a" : "w";
  if (mode === "a") {
    writeFileSync(outFile, lines.join("\n") + "\n", { flag: "a" });
  } else {
    const outDir = dirname(outFile);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, lines.join("\n") + "\n");
  }

  console.log(`[OK] ${dateStr} — merged ${newCount} runs → ${outFile}`);

  // Clean up raw files
  for (const file of files) unlinkSync(join(dayDir, file));
  try { rmdirSync(dayDir); } catch {}

  return newCount;
}

// Merge daily files into a monthly JSONLines file
function mergeMonthly(year, month) {
  const monthDir = join(UPTIME_DIR, year, month);
  const outFile = join(UPTIME_DIR, year, `${month}.jsonl`);

  if (!existsSync(monthDir) || !statSync(monthDir).isDirectory()) {
    return -1;
  }

  const entries = readdirSync(monthDir, { withFileTypes: true });
  const dailyFiles = entries
    .filter((e) => e.isFile() && /^\d{2}\.jsonl$/.test(e.name))
    .sort()
    .map((e) => e.name);

  if (dailyFiles.length === 0) return -1;

  // If monthly already exists, load existing timestamps
  const existing = new Set();
  if (existsSync(outFile)) {
    const old = readFileSync(outFile, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of old) {
      try {
        const ts = JSON.parse(line).timestamp;
        if (ts) existing.add(ts);
      } catch {}
    }
  }

  let totalLines = 0;
  for (const file of dailyFiles) {
    let merged = false;
    try {
      const content = readFileSync(join(monthDir, file), "utf-8");
      const fileLines = content.trim().split("\n").filter(Boolean);
      const newLines = [];
      for (const line of fileLines) {
        try {
          const ts = JSON.parse(line).timestamp;
          if (ts && existing.has(ts)) continue;
          if (ts) existing.add(ts);
          newLines.push(line);
        } catch {}
      }
      if (newLines.length > 0) {
        if (existsSync(outFile)) {
          writeFileSync(outFile, newLines.join("\n") + "\n", { flag: "a" });
        } else {
          writeFileSync(outFile, newLines.join("\n") + "\n");
        }
        totalLines += newLines.length;
        merged = true;
      }
    } catch (err) {
      console.warn(`[WARN] Failed to read ${file}: ${err.message}`);
    }
    // Only delete daily file if data was successfully merged
    if (merged) {
      unlinkSync(join(monthDir, file));
    } else {
      console.warn(`[WARN] ${year}-${month}/${file} — nothing merged, keeping file`);
    }
  }

  console.log(`[OK] ${year}-${month} — monthly merge: ${totalLines} records → ${outFile}`);
  return totalLines;
}

// Generate uptime.json index
function generateIndex() {
  const index = [];

  if (!existsSync(UPTIME_DIR)) {
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
    return index;
  }

  const years = readdirSync(UPTIME_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const year of years) {
    const yearPath = join(UPTIME_DIR, year.name);
    const months = readdirSync(yearPath, { withFileTypes: true }).filter((e) => e.isDirectory());

    for (const month of months) {
      const monthPath = join(yearPath, month.name);

      // Daily merged files (DD.jsonl)
      const dailies = readdirSync(monthPath)
        .filter((f) => /^\d{2}\.jsonl$/.test(f.name))
        .sort();

      for (const file of dailies) {
        const day = file.replace(".jsonl", "");
        const fp = join(monthPath, file);
        let runs = 0;
        try {
          runs = readFileSync(fp, "utf-8").trim().split("\n").filter(Boolean).length;
        } catch {}
        index.push({
          path: `data/uptime/${year.name}/${month.name}/${file}`,
          date: `${year.name}-${month.name}-${day}`,
          type: "daily",
          runs,
        });
      }

      // Raw per-run files (still unmerged)
      const rawDays = readdirSync(monthPath, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const rawDay of rawDays) {
        const rawPath = join(monthPath, rawDay.name);
        const rawFiles = readdirSync(rawPath).filter((f) => f.endsWith(".json"));
        index.push({
          path: `data/uptime/${year.name}/${month.name}/${rawDay.name}/`,
          date: `${year.name}-${month.name}-${rawDay.name}`,
          type: "raw",
          runs: rawFiles.length,
        });
      }
    }

    // Monthly merged files
    const monthFiles = readdirSync(yearPath)
      .filter((f) => /^\d{2}\.jsonl$/.test(f.name))
      .sort();

    for (const file of monthFiles) {
      const month = file.replace(".jsonl", "");
      const fp = join(yearPath, file);
      let runs = 0;
      try {
        runs = readFileSync(fp, "utf-8").trim().split("\n").filter(Boolean).length;
      } catch {}
      index.push({
        path: `data/uptime/${year.name}/${file}`,
        month: `${year.name}-${month}`,
        type: "monthly",
        runs,
      });
    }
  }

  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`[INDEX] Generated ${INDEX_FILE} with ${index.length} entries`);
  return index;
}

// Main
function main() {
  const today = getToday();
  const thisMonth = getThisMonth();

  console.log(`[INFO] Today: ${today.dateStr}, This month: ${thisMonth}`);
  console.log("[INFO] Scanning data/uptime/ for unprocessed data...");

  let totalMerged = 0;
  let totalMonthly = 0;

  if (!existsSync(UPTIME_DIR)) {
    console.log("[SKIP] No uptime data directory yet.");
    generateIndex();
    return;
  }

  const years = readdirSync(UPTIME_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const year of years) {
    const yearPath = join(UPTIME_DIR, year.name);
    const months = readdirSync(yearPath, { withFileTypes: true }).filter((e) => e.isDirectory());

    for (const month of months) {
      const monthPath = join(yearPath, month.name);
      const monthStr = `${year.name}-${month.name}`;

      // Process all days in this month
      const entries = readdirSync(monthPath, { withFileTypes: true });
      const dayDirs = entries.filter((e) => e.isDirectory());

      for (const dayDir of dayDirs) {
        const dateStr = `${year.name}-${month.name}-${dayDir.name}`;

        // Skip today
        if (dateStr === today.dateStr) {
          console.log(`[SKIP] ${dateStr} — today (monitoring in progress)`);
          continue;
        }

        const merged = mergeDaily(year.name, month.name, dayDir.name);
        if (merged >= 0) totalMerged += merged;
      }

      // Monthly merge — process if this month is NOT the current month
      if (monthStr !== thisMonth) {
        const m = mergeMonthly(year.name, month.name);
        if (m >= 0) totalMonthly += m;
      } else {
        console.log(`[SKIP] ${monthStr} — current month, skip monthly merge`);
      }
    }
  }

  // Generate index
  generateIndex();

  console.log(`\n[DONE] Daily merges: ${totalMerged} runs | Monthly merges: ${totalMonthly} records`);
}

main();
