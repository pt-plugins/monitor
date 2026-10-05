# PT Site Monitor

Uptime monitoring for PT sites, driven by **GitHub Actions** and **Astro**.

## How It Works

| Workflow | Schedule | Action |
|---|---|---|
| `monitor.yml` | Every 15 min | HTTP probes all sites, writes results to `data/uptime/` |
| `build.yml` | Every 2 hours | Builds Astro static site, deploys to GitHub Pages |
| `update-source.yml` | Every day | Fetches site definitions from PT-depiler, runs data cleanup |

### Data Source

Site definitions are pulled from [`pt-plugins/PT-depiler`](https://github.com/pt-plugins/PT-depiler) (`src/packages/site/definitions/**/*.ts`). The `siteMetadata` variable in each file provides:

- `id` — unique site identifier
- `name` — display name
- `urls` — array of URLs to probe (ROT13-encoded URLs with `uggcf://` / `uggc://` prefix are auto-decoded by
  `src/lib/site-url.mjs`, the one copy shared by the build and the monitor). Probed in order, stopping at the first
  that answers; the first one also backs the site-URL icon in the detail page header
- `type` — site category
- `descriptions` — optional description
- `isDead` — optional flag to skip monitoring (default: `false`)

### Monitoring Logic

1. Skip sites with `isDead: true`
2. For each site, test each URL with a 15s timeout; stop early if any URL succeeds
3. If a URL fails, retry up to 3 times (2s delay between attempts)
4. Site is **UP** if _any_ URL responds; **DOWN** only if _all_ URLs fail
5. Concurrency limited to 5 sites at a time via `p-queue`
6. Results saved to `data/uptime/YYYY/MM/DD/HH_MM.json`

### Data Cleanup

- **Daily**: merges all per-run files in `data/uptime/YYYY/MM/DD/` into `data/uptime/YYYY/MM/DD.json` (JSONLines), removes raw files
- **Monthly**: merges daily files into `data/uptime/YYYY/MM.json`
- Skips today's data and current month's data (monitoring in progress)
- Generates `data/uptime.json` index of all merged files

### Checks Status (dashboard)

The index page (`src/pages/index.astro`) opens with one **Checks Status** panel above *Active Sites*. Its heading row
carries the last-updated stamp — rendered in **UTC**, like every other check timestamp on the site, whatever zone the
build machine happens to be in. Below it sit the five counters (Sites / Up / Down / Dead / Uptime) and the check heatmap
(`src/components/CheckHeatmap.astro`). Both blocks keep their natural size and are centred as a pair — the spare width
is left on either side rather than stretched into wide, empty tiles or a gap between them — and they stack below 55rem.
The counters say how the sites are doing right now, the heatmap whether monitoring is actually running — a
contribution-graph style calendar with one cell per day, darkening with the number of monitor runs that day.

- The counts come from `computeDailyCheckCounts()` in `src/lib/data-loader.ts`, at build time. Days are bucketed on the
  date part of the run timestamp — the same UTC boundary the rest of the page uses — and the grid is labelled
  accordingly.
- A day with **no** run is kept as an empty cell rather than skipped, and the series is padded through *today*, so a
  lapse in monitoring shows up as trailing empty days instead of the window quietly shrinking to the last run. Days the
  record never reaches are drawn as outlines.
- Columns are Monday-to-Sunday weeks (the newest **26**, older ones fall out of the window), with month labels on the
  column where each month starts and Mon/Wed/Fri labels down the left.
- The counters are a tile grid of two or five per line — never three or four, because four counters do not divide evenly
  into those and the leftover tile leaves a hole. In the narrow two-column form Uptime closes the block as a full-width
  summary tile; on a wide stacked line it takes its place as the fifth tile. The breakpoints are in `rem` so they track
  the reader's font size, which is what the tiles scale with.
- The colour ramp is relative to the busiest day in the window (4 levels): cadence has varied by an order of magnitude
  over the project's life, and fixed thresholds would flatten whole months into one colour. The busiest day and the
  total are printed beside the grid so the ramp is readable.
- Each cell carries a `title` with its date and run count; the grid as a whole is exposed to assistive tech as a single
  labelled image. The card prints its own unit and range (`Runs per day (UTC) · … → …`), since the section heading
  covers several measures and cannot name just one.

### Extended History (client-side)

Each site detail page (`src/pages/site/[id].astro`) renders the **Extended History** component
(`src/components/ExtendedHistory.astro`), whose trigger button sits at the foot of the *Checks History* section and
whose dialog markup, client script and styles live in that component. The static build already embeds the most recent
runs; this dialog additionally fetches the merged history files from the repository in the browser, so long-term
history is available without rebuilding the site on every data update.

The dialog holds only the loader controls and a status line. It renders **no table** of its own: everything it fetches
is merged into the page's *Checks History* table, which is the single place records are read.

- Every site page gets the trigger, regardless of how much history the build embedded, so the dialog is always
  reachable. Sites with little or no built-in history can still pull their full history from the repository.

- On page entry the dialog loads whatever is already in the cache, **without any network request**. It only fetches
  after an explicit **Load** click, so opening a site page never spends API quota. This cache merge is skipped when a
  GitHub token is saved: a token makes the cache grow to the full fetched range, so with one, history loads only after
  a **Load history** click.
- Loading reports per-file progress (`n/total · 2026/08 monthly`, `n/total · 2026/09/28 daily`).
- Fetched records are merged into *Checks History*, deduplicated by timestamp and ordered by absolute instant (so
  ordering stays correct across a year boundary).
- Targets, relative to the repo's `data/uptime/`:
  - whole past months → `YYYY/MM.jsonl` (monthly merge)
  - completed days of the current month → `YYYY/MM/DD.jsonl` (daily merge)
  - nothing earlier than **2026-06**, the first month with merged history data
- Fetched with `fetch()` from the GitHub REST API (`api.github.com/repos/.../contents/...`), requesting the
  `application/vnd.github.v3.raw` media type so the file body is returned directly; then filtered to the current
  site's runs. `raw.githubusercontent.com` is never used.
- Each fetched file is cached with the **Cache API** (`caches.open("ptd-monitor-history-v2")`) under its plain API
  URL, holding the **raw JSONL body exactly as returned**, including an empty result. Filtering to the current site
  happens after the read, so one entry serves every site sharing that file and repeated loads never re-download it.
  Caching a pre-filtered payload under a per-site key is what once let a site render another site's rows.
- Buckets from the older layout (`ptd-monitor-history-v1*`) are deleted automatically on first load; their entries
  cannot be read by the current code.
- Once a month's `MM.jsonl` is confirmed present, that month's cached **daily** files are deleted as redundant. This
  is driven by the monthly file actually being observed, never by guessing from the calendar date.
- **Clear cache** deletes the whole history cache bucket.
- The optional **GitHub token** is stored in `localStorage` under `ptd-monitor:gh-token` and sent as a `Bearer`
  header to `api.github.com` only. Only the token is persisted this way; history payloads live in the Cache API. It
  raises the API rate limit from 60 to 5000 requests per hour; the status line shows the remaining quota reported by
  the API.
- Files that do not exist for a given month/day are treated as "no data" rather than an error.
- Fetched rows reuse `StatusBadge`'s exact markup (`badge badge--<status> badge--sm`, with a `badge-dot`), so merged
  rows are visually identical to the server-rendered ones rather than a separate pill style. Because those rows are
  built by `document.createElement` they carry no Astro scoping attribute, so the page duplicates the `badge` /
  `badge-dot` and cell rules it needs as `:global(...)`; the page owns all styling for its own table.
- When the API reports rate limiting (403/429), loading stops early and the panel asks for a token.
- The Cache API requires a secure context. On plain `http://` origins caching is skipped and files are always
  re-fetched.

## Local Development

### Prerequisites

- Node.js 22.12+ (Astro 7 requires it; CI and `.nvmrc` pin Node 26)
- pnpm 10+
- Git

### Setup

```bash
pnpm install

# Fetch site definitions
pnpm update-source

# Run a monitoring check
pnpm monitor

# Start Astro dev server
pnpm dev
```

### Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Astro dev server |
| `pnpm build` | Build static site to `dist/` |
| `pnpm monitor` | Run uptime checks |
| `pnpm update-source` | Fetch site definitions from PT-depiler |
| `pnpm cleanup` | Merge data files + regenerate index |

## Project Structure

```
/
├── .github/workflows/
│   ├── monitor.yml
│   ├── build.yml
│   └── update-source.yml
├── scripts/
│   ├── update-source.mjs
│   ├── monitor.mjs
│   └── cleanup.mjs
├── src/                    # Astro pages & components
│   ├── pages/
│   │   ├── index.astro
│   │   └── site/[id].astro
│   ├── components/
│   │   ├── Layout.astro
│   │   ├── SiteCard.astro
│   │   ├── CheckHeatmap.astro
│   │   ├── StatusBadge.astro
│   │   ├── LatencyChart.astro
│   │   └── ExtendedHistory.astro
│   └── lib/
│       ├── data-loader.ts
│       ├── history-fetch.ts
│       ├── site-url.mjs     # shared with scripts/monitor.mjs
│       └── types.ts
├── public/                 # Static assets (favicon)
├── data/
│   ├── site.json           # Site definitions
│   ├── uptime.json         # Monitoring data index
│   └── uptime/             # Monitoring results
├── astro.config.mjs
├── package.json
└── tsconfig.json
```

## GitHub Pages Deployment

1. Enable **GitHub Pages** in repo settings → Source: **GitHub Actions**
2. The `build.yml` workflow handles build + deploy automatically
3. Set `site` and `base` in `astro.config.mjs` to match your domain / repo name

## License

MIT
