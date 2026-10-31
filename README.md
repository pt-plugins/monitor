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

### Request Overrides

`data/request-overrides.json` holds per-site adjustments, keyed by site id:

- `method`, `path`, `headers`, `body`, `timeoutMs` — rewrite the probe request, e.g. point it at a login page or a
  static asset the site serves without a challenge.
- `skip` — do not probe the site at all. The run records a **BLOCKED** check instead (which counts as available), so
  the site is not reported down for something this runner cannot observe. Use it for sites a GitHub Actions runner
  cannot reach: region-locked sites (`newstudio` accepts Russian IPs only — Jackett/Jackett#12602) or campus-only
  networks (`sjtu`, `rs` are CERNET-only). The value is printed in the monitor log, so put the reason there.

### Monitoring Logic

1. Skip sites with `isDead: true`
2. A site whose override sets `skip` is not probed: the run records a **BLOCKED** check (see Request Overrides)
3. For each site, test each URL with a 15s timeout; stop early if any URL succeeds
4. If a URL fails, retry up to 3 times (2s delay between attempts)
5. Site is **UP** if _any_ URL responds; **DOWN** only if _all_ URLs fail
6. A **Cloudflare WAF** response (403/503 with `cf-ray`) is not an answer from the site, so it is never recorded as
   up on its own. The probe first tries **cfsolve** (when the workflow built it): it solves the challenge request-side
   and hands back a `cf_clearance` cookie, which the probe then re-sends — same address, same User-Agent as the
   profile, because that cookie is bound to both. If the page behind the challenge loads, the check is **UP**.
   Anything less, including cfsolve failing to solve, falls through to the browser:
   a challenge that clears in Playwright and loads the page is **UP**; a challenge that does not clear leaves the
   check **BLOCKED** — the origin was never observed.
   Non-Cloudflare 403s take the browser fallback directly but stay **DOWN** when it fails, since the origin did answer.
7. A **BLOCKED** check is not an outage. It counts as available everywhere a percentage or a day's status is
   computed (so the dashboard reads the site as up), while the per-check history keeps the `blocked` badge so the
   reason a probe was not the site's own answer stays visible. A site is only **DOWN** when every URL failed without
   a WAF answering for it.
8. Concurrency limited to 5 sites at a time via `p-queue`
9. Results saved to `data/uptime/YYYY/MM/DD/HH_MM.json`

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
- **The snapshot is written in site-id order**, not in the order the lookups finish. The queue settles in whatever
  order the network answers, so a completion-ordered file would reorder itself on every run and show a whole-file diff
  even when no date changed. Site ids are plain ASCII, so the default code-unit sort is stable and locale-independent —
  the order a reader should expect of a file that is only committed to keep its diffs quiet.
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

### Uptime & Response Time (site page)

The first two blocks of a site page answer *is it up, and how slow is it?*: **Uptime** holds three success rates
followed by four latency figures, and **Response Time (7 days)** (`src/components/LatencyChart.astro`) draws the curve
those figures come from.

- The success rates are the share of **checks** that succeeded over the last 24 hours, 7 days and 30 days — a daily
  sample rather than a stopwatch, as *Scheduled Runs Are Best-Effort* above explains.
- The latency figures are the **mean, P90, P95 and P99 over the same 7 days** the chart below draws, so the block and
  the curve cannot disagree about their window. The 24-hour mean they replaced said less about a slow site than the
  percentiles do, and two windows sitting in one row invited reading them as one.
- They describe the checks that **answered**: a failed check has no latency — the monitor records none — so these are
  how fast the site was when it was up, while how much of the window it was not is the cards above and *Daily Uptime*
  below.
- The percentiles are **nearest-rank**: P90 is the slowest of the fastest 90% of the window's checks, a latency that
  was actually recorded rather than one interpolated between two readings. At this cadence a week holds tens of checks
  per site, not hundreds, so the tail figures are coarse by nature — on a thin window P95 and P99 land on the same
  reading, which is what the record supports rather than a rounding artefact.
- The chart buckets the window into **168 hours**, one point per hour holding the mean of the checks that answered in
  it. An hour with no answer is skipped rather than plotted as 0 — a gap in the record is a gap in the line — and each
  day's midnight is drawn down the plot. It is drawn from the 336 checks embedded in the page, so how much of the
  window it covers follows the monitor's real cadence.
- **Every hour that answered is marked** with a small dot on the curve, because the curve alone hides where its own
  points are: it is stroked as one smooth line through them and does not break across an hour nothing answered, so a
  quiet stretch would read as measured. The dots are the hours with evidence behind them and the gaps between them are
  the hours without, and each carries its mean in a tooltip (`483ms avg of 3 checks`) — the reading the curve's shape
  only gestures at.
- **An hour that failed is marked as well**, larger and in the failure colour, since that is the thing to find here. One
  mark covers the hour rather than the check — an hour is a single x on this chart — and it is drawn last, so in an hour
  that both answered and failed the failure is the mark left on top. A failure has no latency to plot, so it borrows the
  curve's height at that hour: it is placed by evaluating the same cubic the line is stroked with, which puts it on the
  line rather than near it. Its tooltip names the hour's newest failure (`3 checks down, latest 2026-10-14 03:12:45
  UTC`).
- A stretch of downtime **before the first answer or after the last** has no curve to sit on. Those marks keep their own
  hour's x and take the height of the nearest end of the line, so an outage that is still running trails off the end of
  the curve at the site's last known latency instead of vanishing. With no answered check anywhere in the window there
  is no curve, and so no marks.
- The marks are positioned HTML rather than SVG circles: the viewBox is stretched to the container, so a circle drawn
  inside it comes out as an ellipse — narrow on a phone, wide on a desktop. They are hidden from assistive tech, and the
  chart's own label carries them instead (`7-day latency chart; 36 measured and 3 failed hours marked`).

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
- The counters are **Worst day**, **Longest outage**, **Days with downtime** and **Current streak**. There is
  deliberately no "best day": a site is usually perfect, so the best day is 100% on whichever date the tie-break lands
  on and says nothing. These four answer how bad it got, how long it stayed bad, how much of the window was spoiled,
  and whether it is holding now.
- **Longest outage** counts whole days on which every check failed. A day with any uptime at all ends the run, so a
  stretch of one-failed-check-in-five days is never reported as an outage, and a day the monitor did not reach ends it
  too — an unmeasured day is evidence of neither. Only days the record reaches can be the worst day, and a tie goes to
  the later one.
- **Days with downtime** carries the split beneath it (`57 whole · 13 partial`). Those are not the same event — a day
  lost outright and a day that dropped one check — and they used to be the same number, which is what made one 98-day
  blackout indistinguishable from a site that flaps for weeks.
- **Current streak** counts whole days up, back from the last measured day. Trailing days with no check are skipped, so
  an early-morning build is not read as an outage, but a gap in the middle ends it: those days cannot be claimed.
- A figure takes a colour only where the ramp has one that works as text — green for a perfect day, red for a total
  outage. The middle bands are tints, and an amber number on a white card is barely legible, so those stay in the body
  colour.
- The footer carries the coverage (`111/111 days measured`, out of the days the window spans). With a best-effort
  schedule an empty cell has to be distinguishable from a quiet day, and someone who reads the grid alone should be
  able to tell how much of it is evidence.
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
