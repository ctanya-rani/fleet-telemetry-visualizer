# Fleet Telemetry Visualizer

**Live demo:** <https://ctanya-rani.github.io/fleet-telemetry-visualizer/> —
no install needed; the full dashboard runs in your browser with the fleet
simulator generating telemetry client-side.

Real-time IoT fleet dashboard plus an event-recorder forensics toolkit:

- **Live fleet map** — device positions, movement trails, and health-colored
  markers streamed over WebSocket (Leaflet + OpenStreetMap tiles).
- **Device health** — per-unit status (healthy / warning / serious / critical),
  active fault codes, and latency / battery / RSSI sparklines.
- **SLA tracking** — rolling 15-minute window against explicit SLOs: uptime,
  message delivery rate, latency p95, and remaining error budget, per device
  and fleet-wide.
- **Event-recorder parser** — ingests recorder dumps in JSONL, CSV, or the
  pipe-framed ERF format (auto-detected) and normalizes them into a single
  event model.
- **Incident timeline reconstructor** — rebuilds incidents from raw events
  (detection → escalations → recovery), computes MTTR and severity stats, and
  renders the result as an interactive SVG timeline in the UI or an ASCII
  timeline in the terminal.

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

## Static demo (GitHub Pages)

`node demo/build.mjs` assembles `_site/` from the real dashboard, parser,
simulator, and SLA modules — the only demo-specific code is a thin browser
backend (`demo/demo-backend.js`) that replaces the WebSocket/API layer, plus
a `node:events` shim wired up via an import map. The
`.github/workflows/deploy-pages.yml` workflow runs the tests, builds the
site, and deploys it to GitHub Pages on every push.
