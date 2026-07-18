/**
 * Fleet telemetry simulator.
 *
 * Simulates a mixed fleet (vans, trucks, drones, fixed sensor hubs) moving
 * around a metro area, producing per-tick telemetry, health status, SLA
 * samples, and event-recorder entries. Faults are injected with a small
 * per-tick probability and follow a lifecycle:
 *
 *   fault (warning/serious) → maybe escalate → recover (…_CLEAR event)
 *
 * COMMS_LOST takes a device fully offline until it recovers, which is what
 * exercises the uptime SLO.
 */

import { EventEmitter } from 'node:events';

const CITY = { lat: 37.7749, lon: -122.4194 }; // San Francisco
const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

const FAULT_LIBRARY = [
  { code: 'ENG_TEMP_HIGH', severity: 'warning', escalatesTo: { code: 'ENG_TEMP_CRIT', severity: 'critical' }, msg: 'Engine temperature above threshold', types: ['van', 'truck'] },
  { code: 'BATT_LOW', severity: 'warning', escalatesTo: { code: 'BATT_CRIT', severity: 'serious' }, msg: 'Battery charge below 20%', types: null },
  { code: 'GPS_DRIFT', severity: 'warning', escalatesTo: null, msg: 'GPS position variance high', types: null },
  { code: 'COMMS_DEGRADED', severity: 'serious', escalatesTo: { code: 'COMMS_LOST', severity: 'critical' }, msg: 'Uplink packet loss above 15%', types: null },
  { code: 'CAN_BUS_ERR', severity: 'serious', escalatesTo: null, msg: 'CAN bus intermittent frame errors', types: ['van', 'truck'] },
  { code: 'IMU_FAULT', severity: 'warning', escalatesTo: null, msg: 'IMU self-test degraded', types: ['drone'] },
];

const FLEET_PLAN = [
  { type: 'van', count: 6 },
  { type: 'truck', count: 4 },
  { type: 'drone', count: 3 },
  { type: 'sensor-hub', count: 3 },
];

export class FleetSimulator extends EventEmitter {
  constructor({ tickMs = 1000, seedOffsetKm = 6 } = {}) {
    super();
    this.tickMs = tickMs;
    this.devices = [];
    this.timer = null;

    let n = 0;
    for (const { type, count } of FLEET_PLAN) {
      for (let i = 1; i <= count; i++) {
        n++;
        this.devices.push(makeDevice(type, i, seedOffsetKm));
      }
    }
  }

  start() {
    if (this.timer) return;
    const now = Date.now();
    for (const d of this.devices) {
      this.#recordEvent(d, now, 'INFO', 'UNIT_ONLINE', 'info', 'Recorder session started');
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()) {
    for (const d of this.devices) {
      this.#move(d);
      this.#drainAndSense(d, now);
      this.#faultLifecycle(d, now);
      d.status = healthStatus(d);
      d.lastSeen = d.online ? now : d.lastSeen;

      this.emit('sample', d.id, {
        ts: now,
        online: d.online,
        delivered: d.online && Math.random() > d.packetLoss,
        latencyMs: d.online ? d.latencyMs : null,
      });
    }
    this.emit('tick', this.snapshot(now));
  }

  snapshot(now = Date.now()) {
    return {
      ts: now,
      devices: this.devices.map((d) => ({
        id: d.id,
        type: d.type,
        lat: round6(d.lat),
        lon: round6(d.lon),
        headingDeg: Math.round(d.heading),
        speedKph: round1(d.online ? d.speedKph : 0),
        batteryPct: round1(d.battery),
        engineTempC: round1(d.engineTempC),
        rssiDbm: Math.round(d.rssiDbm),
        latencyMs: d.online ? Math.round(d.latencyMs) : null,
        online: d.online,
        status: d.status,
        activeFault: d.fault ? { code: d.fault.code, severity: d.fault.severity, since: d.fault.since } : null,
        lastSeen: d.lastSeen,
      })),
    };
  }

  #move(d) {
    if (d.type === 'sensor-hub') return;
    const dtH = this.tickMs / 3_600_000;
    if (Math.random() < 0.05) d.heading += (Math.random() - 0.5) * 60;
    d.heading = (d.heading + 360) % 360;
    const target = d.type === 'drone' ? 60 : 35;
    d.speedKph += (target - d.speedKph) * 0.05 + (Math.random() - 0.5) * 4;
    d.speedKph = Math.max(0, Math.min(90, d.speedKph));
    const km = d.speedKph * dtH;
    const rad = (d.heading * Math.PI) / 180;
    d.lat += (km * Math.cos(rad)) / KM_PER_DEG_LAT;
    d.lon += (km * Math.sin(rad)) / kmPerDegLon(d.lat);
    // Soft leash: steer back toward the city center when straying too far.
    const dLatKm = (d.lat - CITY.lat) * KM_PER_DEG_LAT;
    const dLonKm = (d.lon - CITY.lon) * kmPerDegLon(CITY.lat);
    if (Math.hypot(dLatKm, dLonKm) > 9) {
      d.heading = (Math.atan2(-dLonKm, -dLatKm) * 180) / Math.PI + (Math.random() - 0.5) * 30;
      d.heading = (d.heading + 360) % 360;
    }
  }

  #drainAndSense(d, now) {
    const drainPerTick = d.type === 'drone' ? 0.02 : d.type === 'sensor-hub' ? 0.001 : 0.006;
    d.battery = Math.max(0, d.battery - drainPerTick * (0.5 + Math.random()));
    if (d.battery <= 3) {
      d.battery = 100;
      this.#recordEvent(d, now, 'INFO', 'BATT_SWAP', 'info', 'Battery swapped / recharged');
    }

    const tempTarget = d.fault?.code.startsWith('ENG_TEMP') ? 116 : 88;
    d.engineTempC += (tempTarget - d.engineTempC) * 0.03 + (Math.random() - 0.5) * 1.2;

    d.rssiDbm = -62 + (Math.random() - 0.5) * 10 - (d.fault?.code.startsWith('COMMS') ? 22 : 0);

    const latencyBase = d.fault?.code === 'COMMS_DEGRADED' ? d.baseLatency * 4.5 : d.baseLatency;
    d.latencyMs = Math.max(8, latencyBase + (Math.random() - 0.5) * 24 + (Math.random() < 0.03 ? 180 : 0));

    d.packetLoss = d.fault?.code === 'COMMS_DEGRADED' ? 0.2 : 0.008;
  }

  #faultLifecycle(d, now) {
    if (!d.fault) {
      // ~1 fault per device per ~8 minutes of ticking
      if (Math.random() < this.tickMs / 480_000) {
        const eligible = FAULT_LIBRARY.filter((f) => !f.types || f.types.includes(d.type));
        const spec = eligible[Math.floor(Math.random() * eligible.length)];
        d.fault = {
          code: spec.code,
          severity: spec.severity,
          spec,
          since: now,
          escalateAt: spec.escalatesTo && Math.random() < 0.45 ? now + rand(20_000, 60_000) : null,
          recoverAt: now + rand(30_000, 150_000),
        };
        this.#recordEvent(d, now, 'FAULT', spec.code, spec.severity, spec.msg);
      }
      return;
    }

    const f = d.fault;
    if (f.escalateAt && now >= f.escalateAt) {
      f.code = f.spec.escalatesTo.code;
      f.severity = f.spec.escalatesTo.severity;
      f.escalateAt = null;
      f.recoverAt = now + rand(30_000, 120_000);
      this.#recordEvent(d, now, 'FAULT', f.code, f.severity, `${f.spec.msg} — escalated`);
      if (f.code === 'COMMS_LOST') d.online = false;
    }
    if (now >= f.recoverAt) {
      const wasOffline = !d.online;
      d.online = true;
      this.#recordEvent(d, now, 'RECOVERY', `${f.code}_CLEAR`, 'info',
        wasOffline ? 'Uplink restored, unit back online' : 'Condition cleared');
      d.fault = null;
    }
  }

  #recordEvent(d, ts, type, code, severity, message) {
    this.emit('event', { ts, deviceId: d.id, type, code, severity, message, raw: null });
  }
}

function makeDevice(type, index, spreadKm) {
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * spreadKm;
  const lat = CITY.lat + (dist * Math.cos(angle)) / KM_PER_DEG_LAT;
  const lon = CITY.lon + (dist * Math.sin(angle)) / kmPerDegLon(CITY.lat);
  return {
    id: `${type}-${String(index).padStart(2, '0')}`,
    type,
    lat,
    lon,
    heading: Math.random() * 360,
    speedKph: type === 'sensor-hub' ? 0 : 20 + Math.random() * 20,
    battery: 55 + Math.random() * 45,
    engineTempC: 82 + Math.random() * 8,
    rssiDbm: -62,
    baseLatency: 40 + Math.random() * 50,
    latencyMs: 60,
    packetLoss: 0.008,
    online: true,
    fault: null,
    status: 'good',
    lastSeen: Date.now(),
  };
}

export function healthStatus(d) {
  if (!d.online || d.fault?.severity === 'critical') return 'critical';
  if (d.fault?.severity === 'serious' || d.battery < 10) return 'serious';
  if (d.fault?.severity === 'warning' || d.battery < 20 || d.engineTempC > 105) return 'warning';
  return 'good';
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const round1 = (n) => Math.round(n * 10) / 10;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
