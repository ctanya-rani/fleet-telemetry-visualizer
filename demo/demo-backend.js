/* Browser demo backend for the static GitHub Pages build.
 *
 * Runs the same fleet simulator, SLA tracker, and parser/timeline pipeline
 * the Node server uses — but in-page, so the dashboard works with no backend
 * at all. It stands in for the server by:
 *   - replacing window.WebSocket with a local socket fed by the simulator
 *   - intercepting the app's relative api/… fetches
 * app.js is byte-identical to the one the real server serves.
 */
import { FleetSimulator } from './simulator.js';
import { SlaTracker } from './sla.js';
import { parseEvents } from './eventParser.js';
import { reconstructTimeline } from './timeline.js';

const simulator = new FleetSimulator({ tickMs: 1000 });
const sla = new SlaTracker({ windowMs: 15 * 60_000 });
const recorder = [];

simulator.on('event', (event) => {
  recorder.push(event);
  if (recorder.length > 5000) recorder.splice(0, recorder.length - 5000);
});
simulator.on('sample', (deviceId, sample) => sla.record(deviceId, sample));

// Pre-roll 10 simulated minutes so the SLA window and the recorder buffer
// are already populated when the page loads (nobody watches an empty demo).
const now = Date.now();
for (let t = now - 600_000; t < now; t += 1000) simulator.tick(t);
simulator.start();

function telemetryMessage(snapshot) {
  const summary = sla.fleetSummary(snapshot.ts);
  return {
    type: 'telemetry',
    ...snapshot,
    devices: snapshot.devices.map((d) => ({ ...d, sla: summary.devices[d.id] ?? null })),
    sla: { fleet: summary.fleet, targets: summary.targets },
  };
}

class DemoSocket {
  #listener;

  constructor() {
    this.#listener = (snapshot) =>
      this.onmessage?.({ data: JSON.stringify(telemetryMessage(snapshot)) });
    simulator.on('tick', this.#listener);
    queueMicrotask(() => {
      this.onopen?.();
      this.#listener(simulator.snapshot());
    });
  }

  close() {
    simulator.off('tick', this.#listener);
    this.onclose?.();
  }

  send() {}
}
window.WebSocket = DemoSocket;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.endsWith('api/incidents/live')) {
    return jsonResponse({
      format: 'live', eventCount: recorder.length, parseErrors: [],
      ...reconstructTimeline(recorder),
    });
  }
  if (url.endsWith('api/incidents/parse')) {
    try {
      const { events, errors, format } = parseEvents(String(init?.body ?? ''));
      return jsonResponse({
        format, eventCount: events.length, parseErrors: errors,
        ...reconstructTimeline(events),
      });
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  }
  return realFetch(input, init);
};
