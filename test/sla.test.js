import test from 'node:test';
import assert from 'node:assert/strict';

import { SlaTracker, percentile, DEFAULT_TARGETS } from '../server/sla.js';

const T0 = 1_784_000_000_000;

function feed(tracker, deviceId, specs) {
  specs.forEach((s, i) => {
    tracker.record(deviceId, {
      ts: T0 + i * 1000,
      online: s.online ?? true,
      delivered: s.delivered ?? true,
      latencyMs: s.latencyMs ?? 50,
    });
  });
  return T0 + (specs.length - 1) * 1000;
}

test('percentile interpolates correctly', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5.5);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) - 9.55) < 1e-9);
});

test('all-good samples give 100% and full error budget', () => {
  const sla = new SlaTracker();
  const now = feed(sla, 'van-01', Array.from({ length: 100 }, () => ({})));
  const s = sla.deviceSummary('van-01', now);
  assert.equal(s.uptimePct, 100);
  assert.equal(s.deliveryPct, 100);
  assert.equal(s.errorBudgetPct, 100);
  assert.deepEqual(s.breaches, { uptime: false, delivery: false, latency: false });
});

test('downtime consumes the error budget proportionally', () => {
  // wide window so all 1000 one-second samples stay in scope
  const sla = new SlaTracker({ windowMs: 3_600_000 }); // uptime target 99.5% → 0.5% allowed downtime
  // 1000 samples, 5 offline → exactly the allowed downtime → budget 0, no breach margin
  const specs = Array.from({ length: 1000 }, (_, i) => ({ online: i >= 5, delivered: i >= 5 }));
  const now = feed(sla, 'van-01', specs);
  const s = sla.deviceSummary('van-01', now);
  assert.equal(s.uptimePct, 99.5);
  assert.equal(s.errorBudgetPct, 0);
  assert.equal(s.breaches.uptime, false); // 99.5 is not < 99.5

  const sla2 = new SlaTracker({ windowMs: 3_600_000 });
  // 2 offline out of 1000 → 0.2% downtime of 0.5% allowed → 60% budget left
  const now2 = feed(sla2, 'van-01', Array.from({ length: 1000 }, (_, i) => ({ online: i >= 2, delivered: i >= 2 })));
  const s2 = sla2.deviceSummary('van-01', now2);
  assert.equal(s2.errorBudgetPct, 60);
});

test('latency p95 breach is flagged', () => {
  const sla = new SlaTracker();
  const specs = Array.from({ length: 100 }, (_, i) => ({ latencyMs: i < 90 ? 100 : 900 }));
  const now = feed(sla, 'van-01', specs);
  const s = sla.deviceSummary('van-01', now);
  assert.ok(s.latencyP95Ms > DEFAULT_TARGETS.latencyP95Ms);
  assert.equal(s.breaches.latency, true);
});

test('samples outside the rolling window are pruned', () => {
  const sla = new SlaTracker({ windowMs: 60_000 });
  sla.record('van-01', { ts: T0, online: false, delivered: false, latencyMs: null });
  for (let i = 1; i <= 10; i++) {
    sla.record('van-01', { ts: T0 + 120_000 + i * 1000, online: true, delivered: true, latencyMs: 40 });
  }
  const s = sla.deviceSummary('van-01', T0 + 130_000);
  assert.equal(s.samples, 10);
  assert.equal(s.uptimePct, 100);
});

test('fleet summary aggregates all devices and reports per-device views', () => {
  const sla = new SlaTracker();
  feed(sla, 'van-01', Array.from({ length: 50 }, () => ({})));
  feed(sla, 'van-02', Array.from({ length: 50 }, () => ({ online: false, delivered: false })));
  const { fleet, devices } = sla.fleetSummary(T0 + 49_000);
  assert.equal(fleet.samples, 100);
  assert.equal(fleet.uptimePct, 50);
  assert.equal(devices['van-01'].uptimePct, 100);
  assert.equal(devices['van-02'].uptimePct, 0);
  assert.equal(devices['van-02'].errorBudgetPct, 0);
});

test('offline samples never contribute latency', () => {
  const sla = new SlaTracker();
  const now = feed(sla, 'van-01', [
    { online: true, latencyMs: 40 },
    { online: false, latencyMs: null, delivered: false },
    { online: true, latencyMs: 60 },
  ]);
  const s = sla.deviceSummary('van-01', now);
  assert.ok(s.latencyP95Ms <= 60);
});
