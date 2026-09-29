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
- `urls` — array of URLs to probe (ROT13-encoded URLs with `uggcf://` / `uggc://` prefix are auto-decoded)
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

### Extended History (client-side)

Each site detail page (`src/pages/site/[id].astro`) has an **Extended History** panel. The static build already
embeds the most recent runs; this panel additionally fetches the merged history files from the repository in the
browser, so long-term history is available without rebuilding the site on every data update.

- Targets, relative to the repo's `data/uptime/`:
  - whole past months → `YYYY/MM.jsonl` (monthly merge)
  - completed days of the current month → `YYYY/MM/DD.jsonl` (daily merge)
- Fetched with `fetch()` from `raw.githubusercontent.com`, then filtered to the current site's runs.
- Each fetched file is cached in `localStorage` under `ptd-monitor:history:v1:<path>`, including an empty result,
  so repeated loads and other sites sharing the same file do not re-download it.
- **Clear cache** drops every cached history file.
- The optional **GitHub token** field only raises the anonymous rate limit. It stays in the page and is sent as a
  `Bearer` header to `raw.githubusercontent.com` only; it is never stored or sent anywhere else.
- Files that do not exist for a given month/day are treated as "no data" rather than an error.

## Local Development

### Prerequisites

- Node.js 20+
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
│   │   ├── StatusBadge.astro
│   │   └── LatencyChart.astro
│   └── lib/
│       ├── data-loader.ts
│       ├── history-fetch.ts
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
