/**
 * Rolling-window SLA tracker.
 *
 * Each telemetry tick contributes one sample per device:
 *   { ts, online, delivered, latencyMs }
 *
 * Against the configured SLOs we compute, over the rolling window:
 *   - uptimePct      % of samples where the device was reachable
 *   - deliveryPct    % of expected messages actually delivered
 *   - latencyP95Ms   p95 uplink latency (online samples only)
 *   - errorBudget    % of the window's allowed downtime still unspent
 */

export const DEFAULT_TARGETS = {
  uptimePct: 99.5,
  deliveryPct: 99.0,
  latencyP95Ms: 250,
};

export class SlaTracker {
  constructor({ windowMs = 15 * 60_000, targets = DEFAULT_TARGETS } = {}) {
    this.windowMs = windowMs;
    this.targets = { ...DEFAULT_TARGETS, ...targets };
    this.samples = new Map(); // deviceId -> array of samples (ts ascending)
  }

  record(deviceId, sample) {
    let list = this.samples.get(deviceId);
    if (!list) {
      list = [];
      this.samples.set(deviceId, list);
    }
    list.push(sample);
    this.#prune(list, sample.ts);
  }

  #prune(list, now) {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < list.length && list[drop].ts < cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
  }

  deviceSummary(deviceId, now = Date.now()) {
    const list = this.samples.get(deviceId) ?? [];
    this.#prune(list, now);
    return summarize(list, this.targets);
  }

  fleetSummary(now = Date.now()) {
    const all = [];
    const perDevice = {};
    for (const [deviceId, list] of this.samples) {
      this.#prune(list, now);
      all.push(...list);
      perDevice[deviceId] = summarize(list, this.targets);
    }
    return { fleet: summarize(all, this.targets), devices: perDevice, targets: this.targets };
  }
}

function summarize(samples, targets) {
  const total = samples.length;
  if (total === 0) {
    return {
      samples: 0, uptimePct: null, deliveryPct: null, latencyP95Ms: null,
      errorBudgetPct: null, breaches: {},
    };
  }

  let online = 0;
  let delivered = 0;
  const latencies = [];
  for (const s of samples) {
    if (s.online) {
      online++;
      if (Number.isFinite(s.latencyMs)) latencies.push(s.latencyMs);
    }
    if (s.delivered) delivered++;
  }

  const uptimePct = (online / total) * 100;
  const deliveryPct = (delivered / total) * 100;
  const latencyP95Ms = percentile(latencies, 95);

  // Error budget: how much of the allowed downtime for this window is left.
  const allowedDowntime = 1 - targets.uptimePct / 100;
  const actualDowntime = 1 - online / total;
  const errorBudgetPct = allowedDowntime > 0
    ? Math.max(0, (1 - actualDowntime / allowedDowntime) * 100)
    : (actualDowntime === 0 ? 100 : 0);

  return {
    samples: total,
    uptimePct: round2(uptimePct),
    deliveryPct: round2(deliveryPct),
    latencyP95Ms: latencyP95Ms == null ? null : Math.round(latencyP95Ms),
    errorBudgetPct: round2(errorBudgetPct),
    breaches: {
      uptime: uptimePct < targets.uptimePct,
      delivery: deliveryPct < targets.deliveryPct,
      latency: latencyP95Ms != null && latencyP95Ms > targets.latencyP95Ms,
    },
  };
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
