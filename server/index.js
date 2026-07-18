/**
 * Fleet telemetry server.
 *
 *  - Serves the dashboard (public/) and Leaflet from node_modules
 *  - Runs the fleet simulator and streams snapshots over WebSocket (/ws)
 *  - Tracks SLA compliance in a rolling window
 *  - Keeps the fleet's event-recorder ring buffer and exposes the
 *    parser/timeline pipeline over HTTP
 */

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { FleetSimulator } from './simulator.js';
import { SlaTracker } from './sla.js';
import { parseEvents, toErf } from '../src/parser/eventParser.js';
import { reconstructTimeline } from '../src/parser/timeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const RECORDER_CAPACITY = 5000;

const app = express();
app.use(express.text({ type: ['text/*', 'application/json', 'application/octet-stream'], limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/sample-incident-log.jsonl', (req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, '..', 'sample-data', 'incident-log.jsonl'));
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));

const simulator = new FleetSimulator({ tickMs: 1000 });
const sla = new SlaTracker({ windowMs: 15 * 60_000 });

// Event-recorder ring buffer (normalized events, oldest first).
const recorder = [];
simulator.on('event', (event) => {
  recorder.push(event);
  if (recorder.length > RECORDER_CAPACITY) recorder.splice(0, recorder.length - RECORDER_CAPACITY);
  broadcast({ type: 'event', event });
});
simulator.on('sample', (deviceId, sample) => sla.record(deviceId, sample));

// --- REST API ---------------------------------------------------------------

app.get('/api/fleet', (req, res) => {
  res.json(withSla(simulator.snapshot()));
});

app.get('/api/sla', (req, res) => {
  res.json(sla.fleetSummary());
});

app.get('/api/recorder', (req, res) => {
  res.type('text/plain').send(toErf(recorder));
});

// Parse an uploaded/pasted recorder dump and reconstruct its timeline.
app.post('/api/incidents/parse', (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return res.status(400).json({ error: 'empty body — send the recorder dump as text' });
  const format = req.query.format ?? 'auto';
  const gapMs = req.query.gapMin ? Number(req.query.gapMin) * 60_000 : undefined;
  try {
    const { events, errors, format: detected } = parseEvents(text, { format });
    const timeline = reconstructTimeline(events, gapMs ? { gapMs } : {});
    res.json({ format: detected, eventCount: events.length, parseErrors: errors, ...timeline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Run the same pipeline over the live in-memory recorder buffer.
app.get('/api/incidents/live', (req, res) => {
  const timeline = reconstructTimeline(recorder);
  res.json({ format: 'live', eventCount: recorder.length, parseErrors: [], ...timeline });
});

// --- WebSocket streaming ----------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

simulator.on('tick', (snapshot) => {
  broadcast({ type: 'telemetry', ...withSla(snapshot) });
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'telemetry', ...withSla(simulator.snapshot()) }));
});

function withSla(snapshot) {
  const summary = sla.fleetSummary(snapshot.ts);
  return {
    ...snapshot,
    devices: snapshot.devices.map((d) => ({ ...d, sla: summary.devices[d.id] ?? null })),
    sla: { fleet: summary.fleet, targets: summary.targets },
  };
}

simulator.start();
server.listen(PORT, () => {
  console.log(`fleet-telemetry-visualizer listening on http://localhost:${PORT}`);
});
