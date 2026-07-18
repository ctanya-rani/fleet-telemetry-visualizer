import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseEvents } from '../src/parser/eventParser.js';
import { reconstructTimeline, isRecoveryEvent, formatDuration } from '../src/parser/timeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(path.join(__dirname, '..', 'sample-data', 'incident-log.jsonl'), 'utf8');

const T0 = Date.UTC(2026, 6, 16, 8, 0, 0);
const min = (m) => T0 + m * 60_000;
const ev = (tsMin, deviceId, type, code, severity, message = '') =>
  ({ ts: min(tsMin), deviceId, type, code, severity, message, raw: null });

test('sample log reconstructs the expected incidents', () => {
  const { events } = parseEvents(sample);
  const { incidents, stats, range } = reconstructTimeline(events);

  assert.equal(incidents.length, 5);
  assert.ok(range.start < range.end);

  // van-03 engine incident: warning → critical escalation → recovery
  const engine = incidents.find((i) => i.rootCause.code === 'ENG_TEMP_HIGH');
  assert.ok(engine);
  assert.equal(engine.deviceId, 'van-03');
  assert.equal(engine.peakSeverity, 'critical');
  assert.equal(engine.resolved, true);
  assert.deepEqual(
    engine.phases.map((p) => p.type),
    ['detected', 'activity', 'escalated', 'annotation', 'recovered'],
  );

  // truck-01 comms incident escalates to critical and recovers
  const comms = incidents.find((i) => i.deviceId === 'truck-01');
  assert.equal(comms.peakSeverity, 'critical');
  assert.equal(comms.resolved, true);

  // trailing GPS_DRIFT never recovers
  const gps = incidents.find((i) => i.rootCause.code === 'GPS_DRIFT');
  assert.equal(gps.resolved, false);
  assert.equal(gps.durationMs, gps.end - gps.start);

  assert.equal(stats.total, 5);
  assert.equal(stats.resolved, 4);
  assert.equal(stats.unresolved, 1);
  assert.equal(stats.worstDevice.deviceId, 'van-03');
  assert.equal(stats.worstDevice.count, 2);
  assert.deepEqual(stats.bySeverity, { warning: 2, serious: 1, critical: 2 });
  assert.ok(stats.mttrMs > 0);
});

test('faults separated by more than gapMs split into distinct incidents', () => {
  const events = [
    ev(0, 'van-01', 'FAULT', 'GPS_DRIFT', 'warning'),
    ev(2, 'van-01', 'FAULT', 'GPS_DRIFT', 'warning'),
    ev(60, 'van-01', 'FAULT', 'GPS_DRIFT', 'warning'), // 58 min later
  ];
  const { incidents } = reconstructTimeline(events, { gapMs: 15 * 60_000 });
  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].resolved, false);
  assert.equal(incidents[0].end, min(2));
});

test('recovery with no open incident is ignored', () => {
  const { incidents } = reconstructTimeline([
    ev(0, 'van-01', 'RECOVERY', 'X_CLEAR', 'info'),
    ev(1, 'van-01', 'INFO', 'UNIT_ONLINE', 'info'),
  ]);
  assert.equal(incidents.length, 0);
});

test('per-device streams are independent', () => {
  const events = [
    ev(0, 'a', 'FAULT', 'F1', 'warning'),
    ev(1, 'b', 'FAULT', 'F2', 'serious'),
    ev(2, 'a', 'RECOVERY', 'F1_CLEAR', 'info'),
  ];
  const { incidents } = reconstructTimeline(events);
  assert.equal(incidents.length, 2);
  const a = incidents.find((i) => i.deviceId === 'a');
  const b = incidents.find((i) => i.deviceId === 'b');
  assert.equal(a.resolved, true);
  assert.equal(b.resolved, false);
});

test('escalation raises peak severity exactly once per step', () => {
  const events = [
    ev(0, 'a', 'FAULT', 'F', 'warning'),
    ev(1, 'a', 'FAULT', 'F2', 'critical'),
    ev(2, 'a', 'FAULT', 'F3', 'warning'), // lower severity: activity, not escalation
    ev(3, 'a', 'RECOVERY', 'F2_CLEAR', 'info'),
  ];
  const { incidents } = reconstructTimeline(events);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].peakSeverity, 'critical');
  assert.deepEqual(incidents[0].phases.map((p) => p.type), ['detected', 'escalated', 'activity', 'recovered']);
});

test('isRecoveryEvent matches recovery types and code suffixes', () => {
  assert.ok(isRecoveryEvent({ type: 'RECOVERY', code: 'ANY' }));
  assert.ok(isRecoveryEvent({ type: 'FAULT', code: 'ENG_TEMP_OK' }));
  assert.ok(isRecoveryEvent({ type: 'INFO', code: 'LINK_RESTORED' }));
  assert.ok(!isRecoveryEvent({ type: 'FAULT', code: 'ENG_TEMP_HIGH' }));
});

test('formatDuration renders human-readable durations', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(29 * 60_000 + 33_000), '29m 33s');
  assert.equal(formatDuration(3 * 3_600_000 + 5 * 60_000), '3h 5m');
});

test('empty input produces an empty timeline', () => {
  const { incidents, stats, range } = reconstructTimeline([]);
  assert.equal(incidents.length, 0);
  assert.equal(range, null);
  assert.equal(stats.total, 0);
  assert.equal(stats.mttrMs, null);
});
