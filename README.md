# Tracker Site Status

Uptime monitoring for PT sites, driven by **GitHub Actions** and **Astro**.

## How It Works

| Workflow | Requested schedule | Action |
|---|---|---|
| `monitor.yml` | Every 15 min | HTTP probes all sites, writes results to `data/uptime/` |
| `build.yml` | Every 2 hours | Builds Astro static site, deploys to GitHub Pages |
| `update-source.yml` | Every day | Fetches site definitions from PT-depiler, runs data cleanup |
| `certificates.yml` | Every 3 days | Reads TLS certificate and domain expiry dates into one snapshot |

### Scheduled Runs Are Best-Effort

**Those crons are a request, not a promise.** GitHub runs scheduled workflows on a best-effort basis: a `schedule`
event queues behind whatever else is running in the repository and is delayed — sometimes by hours, most often around
the top of the hour — and when the queue is loaded, queued runs are dropped outright rather than run late. None of this
is reported as an error; the run simply does not happen.

Measured against this repository's own history, the monitor's `*/15` cron has produced — a perfect 15-minute cadence
would be 96 runs a day:

| Month | Runs/day |
|---|---|
| 2026-06 (from the 24th, the first days with data) | 9.3 |
| 2026-07 | 12.4 |
| 2026-08 | 17.2 |
| 2026-09 | 6.2 |
| 2026-10 | 4.5 |

The median gap between two runs is **89 minutes**, and only 9% of gaps are half an hour or less. So the real cadence
sits somewhere between a fifth and a twentieth of what the cron asks for, and it drifts with whatever else GitHub is
running that day.

Nothing in the data model assumes the nominal interval, which is why this degrades gracefully:

- every run stamps itself with its own timestamp, and uptime is computed from the runs that actually exist;
- the dashboard heatmap counts runs per UTC day, so a slow period shows up as a sparse calendar instead of being
  averaged away;
- the site is rebuilt on `build.yml`'s own schedule (and on push), not per check.

One consequence is worth knowing when reading the numbers: uptime is the share of *checks* that succeeded, not time
weighted. With five runs a day, one failed check reads as 80% for that window, where the same outage sampled every 15
minutes would read as about 1%. The percentages are a daily sample, not a stopwatch.

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

### Certificate & Domain Expiry

Two dates that move on the scale of weeks, not minutes: when a site's TLS certificate expires, and when its domain
registration does. They are collected by `scripts/certificates.mjs` (run by `certificates.yml`, **nominally every third
day**) into a **single snapshot** at `data/certificates.json`, which each run overwrites. There is no history to merge,
index or clean up, and the site detail page reads that one file.

- **Certificate.** The first HTTPS URL that completes a TLS handshake is used, walking a site's URLs in the same order
  the monitor probes them. The connection is made with verification switched off (`rejectUnauthorized: false`)
  precisely so that an *expired* or otherwise untrusted certificate still reports its expiry date instead of the
  connection simply being refused. Whether the chain actually verifies is recorded separately and shown as
  `Chain not trusted: …` beside the date.
- **Domain.** RDAP where the TLD publishes it, WHOIS otherwise. The RDAP endpoint is resolved per TLD from IANA's
  bootstrap (`data.iana.org/rdap/dns.json`) rather than through a single redirector, which rate-limits a run of this
  size; one lookup is made per *registrable* domain, shared by a site's mirror URLs and by every site on the same
  registry. TLDs with no RDAP — among them `.cn`, `.me` and `.de` — are queried over WHOIS instead, serially and just
  over a second apart, because those servers throttle bulk querying. A registry that discloses no expiry date at all
  (`.de`) is reported as unavailable rather than guessed at.
- **The snapshot carries no hostnames.** `sites` is an object keyed by site id — the same shape as
  `data/request-overrides.json`, so an id is written once, as its key, rather than repeated in every entry — and an entry
  holds only the dates, the issuer or registrar, and any error: not the host whose certificate was read, nor the
  registrable domain that was looked up. The URLs are used for the lookups, never written down. The command's own log
  still names the host it queried, which is what makes a failure diagnosable.
- **Only the absolute dates are stored.** The days remaining are computed at *build* time, so a snapshot a few days
  old still renders a current countdown, refreshed with the rest of the site every two hours.
- **A run measures only what it has to.** A date the previous snapshot already placed more than **30 days** out is
  carried over untouched, `checkedAt` and all; one inside that window, one whose last attempt failed or did not verify,
  and one that has now gone **30 days** without being read are measured again. A steady state therefore costs a handful
  of lookups instead of a few hundred — which is also what keeps the registries from throttling a run — and because each
  field dates itself, the cards show a `Checked` date that can lag well behind the snapshot's `Updated` one.
- The two thresholds do different jobs. The window decides when a date starts to matter; the age cap decides how long
  any single reading may stand for, so nothing is carried indefinitely. The cap is what eventually notices a
  certificate renewed ahead of schedule, or a site that has changed address — neither of which a reading that only
  follows the expiry could ever have seen earlier. Anything that failed is measured again next time.
- **A 429 stops the run.** A registry answering `429` is asking for a pause, not reporting a hiccup on one domain, so
  the lookup is not retried and does not fall through to WHOIS either — that is the same operator being asked the same
  question. Everything still to come keeps the reading it already had, and a site the snapshot never knew about is left
  out rather than written down as a failure. The run still writes its file and exits successfully: the sites measured
  before the limit are kept, and the ones skipped are simply picked up next time. `503` is treated differently — as a
  service that is momentarily unavailable, it is waited out in place (honouring `Retry-After`) rather than taking the
  whole run down with it.
- Sites marked `isDead` are skipped; a site added since the last collection reads *Not checked yet* rather than as a
  failure, as does a domain the registry would not answer for.
- The workflow joins the shared `uptime-pipeline` concurrency group, so its commit cannot race the monitor's, and sets
  up WARP for the same reason the monitor does — an IPv6-only site that cannot be reached has no certificate to read.

On the site page the block sits under *Uptime*, as two cards (SSL Certificate, Domain Registration). Each carries its
state as a word — `Valid`, `Expiring soon`, `Expired`, `Unavailable` — as well as a colour, plus the expiry date, the
days left, the issuer or registrar, and the date *that* value was read (`Checked`). *Expiring soon* means 14 days or
fewer for a certificate, which is normally renewed well before it lapses, but 30 for a domain registration, which is not
renewed automatically — so it gets the longer notice. The section heading carries when the snapshot itself was written
(`Updated`), which an incremental run can leave well ahead of the dates below it.

### Checks Status (dashboard)

The index page (`src/pages/index.astro`) opens with one **Checks Status** panel above *Active Sites*. Its heading row
carries the last-updated stamp — rendered in **UTC**, like every other check timestamp on the site, whatever zone the
build machine happens to be in. Below it sit the five counters (Sites / Up / Down / Dead / Uptime) and the check heatmap
(`src/components/CheckHeatmap.astro`). Both blocks keep their natural size and are centred as a pair — the spare width
is left on either side rather than stretched into wide, empty tiles or a gap between them — and they stack below 55rem.
The counters say how the sites are doing right now, the heatmap whether monitoring is actually running — a
contribution-graph style calendar with one cell per day, darkening with the number of monitor runs that day. The
heatmap is the honest answer to "how often does this actually check?", which is a different number from the cron (see
*Scheduled Runs Are Best-Effort* above).

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

### Daily Uptime (site page)

A site page runs, top to bottom: *Uptime*, *Response Time (7 days)*, *Daily Uptime*, *Certificate & Domain*, then
*Checks History*. The third of those is the dashboard heatmap's sibling on one site
(`src/components/SiteUptimeHeatmap.astro`, `computeSiteDailyUptime()` in `src/lib/data-loader.ts`): the same
contribution-graph calendar — whole Monday-to-Sunday weeks, month labels on the column where each month starts,
Mon/Wed/Fri down the left, newest 26 weeks — with one square per UTC day.

It is a separate component from `CheckHeatmap.astro` rather than a mode of it, because the two answer different
questions. That one counts **monitor runs**, which is a fact about the monitor and reads identically on all 250-odd site
pages; this one measures **the site**, so every page gets its own grid.

- A day's value is the share of that day's checks which succeeded, so the ramp runs from the failure colour at 0% to
  the success colour at 100% rather than darkening one hue: red and pale green have to be told apart at a glance, not
  by comparing tints. The reference points are absolute here, where the dashboard's are relative to the busiest day —
  there is nothing to be relative to for a single site, and "80% is the best this site ever managed" would read as
  good when it is not.
- A day the record does not reach — before the site's first check, or after the last run — is an outline, not a 0%:
  "not measured" and "measured, and down" are different answers. The series is contiguous from the site's own first
  check through today, so a lapse in monitoring shows as a run of outlines instead of the window shrinking.
- The counters are **Best day**, **Worst day** (each with its date) and **Days with downtime**. Only days the record
  reaches can be either, and ties go to the later day: a site is usually perfect, so a "best day" meaning the oldest
  unbroken one would be a constant, while the most recent one says when it last held.
- A figure takes a colour only where the ramp has one that works as text — green for a perfect day, red for a total
  outage. The middle bands are tints, and an amber number on a white card is barely legible, so those stay in the body
  colour.
- The page needs the site's whole history to fill the grid, which the 336 checks embedded in the page cannot cover, so
  the series is computed at build time from the same runs the dashboard reads. There is no client-side fetching here,
  unlike *Extended History*.

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
| `pnpm certificates` | Check TLS certificate and domain expiry |
| `pnpm update-source` | Fetch site definitions from PT-depiler |
| `pnpm cleanup` | Merge data files + regenerate index |

## Project Structure

```
/
├── .github/workflows/
│   ├── monitor.yml
│   ├── build.yml
│   ├── update-source.yml
│   └── certificates.yml
├── scripts/
│   ├── update-source.mjs
│   ├── monitor.mjs
│   ├── certificates.mjs
│   └── cleanup.mjs
├── src/                    # Astro pages & components
│   ├── pages/
│   │   ├── index.astro
│   │   └── site/[id].astro
│   ├── components/
│   │   ├── Layout.astro
│   │   ├── SiteCard.astro
│   │   ├── CheckHeatmap.astro
│   │   ├── SiteUptimeHeatmap.astro
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
│   ├── certificates.json   # Latest certificate / domain expiry snapshot
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
