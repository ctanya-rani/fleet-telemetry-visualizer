# Fleet Telemetry Visualizer

**🚀 [Live demo on GitHub Pages](https://ctanya-rani.github.io/fleet-telemetry-visualizer/)** — no install needed; the full dashboard runs in your browser with the fleet simulator generating telemetry client-side.

A production-grade **real-time IoT fleet monitoring dashboard** featuring live GPS tracking, device health monitoring, SLA compliance tracking, and incident forensics. Built with vanilla JavaScript, Leaflet maps, Node.js backend, and a built-in fleet simulator.

**Core features:**

- **Live fleet map** — real-time device positions, movement trails, and health-colored markers (Leaflet + OpenStreetMap). Click any device for detailed metrics.
- **Fleet analytics dashboard** — at-a-glance fleet stats (total devices, online count, average health score, active fault count) with rolling SLA metrics.
- **Device health monitoring** — per-unit status (healthy/warning/serious/critical), active fault codes, latency/battery/signal sparklines with interactive tooltips.
- **SLA tracking** — rolling 15-minute window with real-time breaches: uptime %, message delivery %, latency p95, error budget remaining (fleet + per-device).
- **Device search & filtering** — find devices by name/ID, filter by online status or active faults, sort by criticality.
- **Incident forensics** — ingests JSONL/CSV/ERF event dumps (format auto-detected), reconstructs incidents with detection → escalation → recovery phases, calculates MTTR and per-device impact.
- **Interactive timeline** — SVG Gantt chart with per-incident detail cards, phase breakdown, and severity tracking; export-ready for incident reports.
- **Terminal CLI** — incident reconstruction from the command line with ASCII timeline output for automation/alerting pipelines.

A built-in fleet simulator (16 vans / trucks / drones / sensor hubs around
San Francisco) generates telemetry, faults, and recorder events, so the whole
stack runs with no hardware.

## Quick start

```bash
npm install
npm start          # http://localhost:3000  (PORT env var to override)
npm test           # parser, timeline, and SLA unit tests (node:test)
```

The **Live Fleet** tab shows the map, device list, and SLA tiles immediately.
The **Incident Timeline** tab reconstructs incidents from:

- the live simulator's recorder buffer (one click),
- an uploaded/pasted recorder dump (format auto-detected),
- the bundled sample dump.

Map tiles require internet access; everything else works offline.

## CLI

```bash
node src/parser/cli.js sample-data/incident-log.jsonl
node src/parser/cli.js sample-data/incident-log.erf --device van-03
node src/parser/cli.js - --format csv < dump.csv     # read stdin
node src/parser/cli.js dump.jsonl --json             # machine-readable output
```

Options: `--format jsonl|csv|erf` (default auto), `--gap <minutes>` incident
split gap (default 15), `--device <id>` filter, `--width <cols>` ASCII chart
width, `--json`.

Example output:

```
Parsed 18 events (format: jsonl)
Window: 2026-07-16 07:55:00Z → 2026-07-16 10:26:31Z
Incidents: 5 (4 resolved, 1 unresolved)  MTTR: 21m 6s  Worst device: van-03 (2)

INC-001 van-03   !===^==v····································
INC-002 drone-02 ···········!==v·····························
...
```

## Recorder formats

All formats normalize to `{ ts, deviceId, type, code, severity, message }`
with severity in `info | warning | serious | critical`. Malformed lines are
reported with line numbers and skipped, never fatal.

**JSONL** — one object per line; key names are flexible
(`ts`/`timestamp`/`time`, `device`/`device_id`/`unit`, `msg`/`message`, …):

```json
{"ts":"2026-07-16T08:02:11Z","device":"van-03","type":"FAULT","code":"ENG_TEMP_HIGH","severity":"warning","msg":"Engine temperature above threshold"}
```

**CSV** — header row required, flexible column names, quoted fields supported.

**ERF** — compact pipe-framed dump (what the on-board recorder writes):

```
#ERF1
1784188931000|van-03|FAULT|ENG_TEMP_HIGH|W|Engine temperature above threshold
```

Severity codes: `I`nfo, `W`arning, `S`erious, `C`ritical. Timestamps may be
epoch seconds or milliseconds; both are accepted everywhere.

## Incident reconstruction rules

- An incident opens at a device's first `warning`-or-worse event.
- Later events on that device join it; a fault arriving more than the gap
  (default 15 min) after the last activity starts a new incident.
- A severity increase is recorded as an **escalation** phase.
- Recovery events (`RECOVERY`/`CLEAR`/`RESOLVED` types, or codes ending in
  `_CLEAR`, `_OK`, `_RECOVERED`, `_RESTORED`, `_NORMAL`) **resolve** the
  incident — even after a quiet gap, since they reference the open condition
  (a unit returning after a long comms blackout). Anything still open at
  end-of-log is reported as unresolved.
- Stats: total/resolved/unresolved counts, per-severity counts, MTTR (mean
  time to recovery over resolved incidents), and the worst device.

## SLA model

Every telemetry tick contributes one sample per device
(`online`, `delivered`, `latencyMs`). Over the rolling window (15 min):

| Metric | SLO target | Definition |
|---|---|---|
| Uptime | ≥ 99.5 % | share of samples where the unit was reachable |
| Delivery | ≥ 99 % | share of expected messages actually delivered |
| Latency p95 | ≤ 250 ms | p95 uplink latency over online samples |
| Error budget | — | share of the window's allowed downtime still unspent |

## HTTP API

| Route | Description |
|---|---|
| `GET /api/fleet` | current snapshot: devices + health + per-device SLA |
| `GET /api/sla` | fleet + per-device SLA summaries and targets |
| `GET /api/recorder` | live event-recorder ring buffer as ERF text |
| `POST /api/incidents/parse` | body = recorder dump text (`?format=`, `?gapMin=`) → parsed events + reconstructed timeline |
| `GET /api/incidents/live` | run the reconstruction over the live buffer |
| `WS /ws` | telemetry snapshots (1 Hz) and recorder events as they happen |

## Project layout

```
server/index.js        HTTP + WebSocket server, REST API
server/simulator.js    fleet simulator (movement, faults, recorder events)
server/sla.js          rolling-window SLA tracker
src/parser/            eventParser.js, timeline.js, cli.js (shared by server & CLI)
public/                dashboard (vanilla JS + Leaflet)
demo/                  static GitHub Pages build (browser-side backend + assembler)
sample-data/           the same incident log in all three formats
test/                  node:test unit tests
```

## Design & UX

The dashboard is built for clarity and performance:

- **Responsive layout** — adapts from desktop (map + sidebar) to mobile (stacked)
- **Dark mode support** — follows OS preference or manual toggle; CSS custom properties for theme consistency
- **Accessibility** — ARIA labels, keyboard navigation, focus indicators, respects `prefers-reduced-motion`
- **Real-time updates** — WebSocket telemetry at 1 Hz; SLA metrics update every second
- **Error resilience** — WebSocket auto-reconnect with exponential backoff; malformed records skipped with detailed error logs
- **Status indicators** — pulsing connection dot, color-coded device health (good/warning/serious/critical), SLA breach warnings

## Deployment

### GitHub Pages (production)

The site auto-deploys to GitHub Pages on every push to `claude/iot-fleet-telemetry-viz-8j9in9`:

1. GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) runs tests
2. Builds static site with `node demo/build.mjs`
3. Deploys to `gh-pages` branch
4. GitHub Pages serves at: https://ctanya-rani.github.io/fleet-telemetry-visualizer/

**First-time setup:** Visit repo **Settings > Pages** and set:
- Source: Deploy from a branch
- Branch: `gh-pages` / root
- Save (auto-enables if gh-pages exists)

### Local development
```bash
npm install
npm start           # Starts server at http://localhost:3000
npm test            # Runs 24 unit tests (parser, timeline, SLA)
npm run build       # Builds static site for Vercel
```

### Static site assembly

`node demo/build.mjs` assembles `_site/` from the real dashboard, parser,
simulator, and SLA modules — the only demo-specific code is a thin browser
backend (`demo/demo-backend.js`) that replaces the WebSocket/API layer, plus
a `node:events` shim wired up via an import map. The
`.github/workflows/deploy-pages.yml` workflow tests, builds the site, and
deploys it on every push.
