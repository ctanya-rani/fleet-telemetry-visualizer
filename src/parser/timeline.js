/**
 * Incident timeline reconstructor.
 *
 * Takes normalized recorder events (see eventParser.js) and rebuilds what
 * actually happened per device: incidents with a detection point, escalation
 * steps, peak severity, recovery, and duration — plus fleet-level stats
 * (MTTR, counts by severity, worst device).
 *
 * Rules:
 *  - An incident opens at the first event with severity >= warning on a device.
 *  - Later events on the same device join the open incident; a follow-up fault
 *    arriving more than `gapMs` after the incident's last activity starts a
 *    NEW incident instead (the old one is closed as unresolved).
 *  - Severity increases are recorded as escalation phases.
 *  - Recovery events (type RECOVERY/CLEAR/RESOLVED, or a code ending in
 *    _CLEAR/_OK/_RECOVERED/_RESTORED) close the incident.
 *  - info events during an incident are kept as annotations.
 */

import { severityRank } from './eventParser.js';

const RECOVERY_TYPES = new Set(['RECOVERY', 'CLEAR', 'CLEARED', 'RESOLVED', 'RESTORE', 'RESTORED']);
const RECOVERY_CODE_SUFFIXES = ['_CLEAR', '_CLEARED', '_OK', '_RECOVERED', '_RESTORED', '_NORMAL'];

export function isRecoveryEvent(event) {
  if (RECOVERY_TYPES.has(event.type)) return true;
  return RECOVERY_CODE_SUFFIXES.some((s) => event.code.endsWith(s));
}

export const DEFAULT_GAP_MS = 15 * 60 * 1000;

/**
 * @param {Array} events normalized, any order
 * @param {object} [options]
 * @param {number} [options.gapMs] inactivity gap that splits incidents
 * @returns {{ incidents: Array, stats: object, range: {start:number,end:number}|null }}
 */
export function reconstructTimeline(events, { gapMs = DEFAULT_GAP_MS } = {}) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.deviceId.localeCompare(b.deviceId));
  const range = sorted.length ? { start: sorted[0].ts, end: sorted[sorted.length - 1].ts } : null;

  const open = new Map(); // deviceId -> incident under construction
  const incidents = [];
  let seq = 0;

  const close = (incident, endTs, resolved) => {
    incident.end = endTs;
    incident.resolved = resolved;
    incident.durationMs = endTs - incident.start;
    incidents.push(incident);
  };

  for (const event of sorted) {
    const current = open.get(event.deviceId);

    // A stale open incident (no activity within gapMs) gets closed as
    // unresolved before this event is considered on its own. Recovery
    // events are exempt: they reference the open condition and close it
    // properly however long the quiet period was (e.g. a unit that comes
    // back online after a long comms blackout).
    if (current && event.ts - current.lastActivity > gapMs && !isRecoveryEvent(event)) {
      close(current, current.lastActivity, false);
      open.delete(event.deviceId);
    }

    const incident = open.get(event.deviceId);
    const isFaultLike = severityRank(event.severity) >= severityRank('warning');

    if (!incident) {
      if (isFaultLike && !isRecoveryEvent(event)) {
        seq += 1;
        open.set(event.deviceId, {
          id: `INC-${String(seq).padStart(3, '0')}`,
          deviceId: event.deviceId,
          start: event.ts,
          end: null,
          durationMs: null,
          resolved: false,
          peakSeverity: event.severity,
          rootCause: { code: event.code, message: event.message, ts: event.ts },
          phases: [phase('detected', event)],
          events: [event],
          lastActivity: event.ts,
        });
      }
      continue; // recovery/info with no open incident: nothing to attach to
    }

    incident.events.push(event);
    incident.lastActivity = event.ts;

    if (isRecoveryEvent(event)) {
      incident.phases.push(phase('recovered', event));
      close(incident, event.ts, true);
      open.delete(event.deviceId);
    } else if (severityRank(event.severity) > severityRank(incident.peakSeverity)) {
      incident.peakSeverity = event.severity;
      incident.phases.push(phase('escalated', event));
    } else if (isFaultLike) {
      incident.phases.push(phase('activity', event));
    } else {
      incident.phases.push(phase('annotation', event));
    }
  }

  // Anything still open at end-of-log is an unresolved, ongoing incident.
  for (const incident of open.values()) close(incident, incident.lastActivity, false);

  incidents.sort((a, b) => a.start - b.start);
  for (const inc of incidents) delete inc.lastActivity;

  return { incidents, stats: computeStats(incidents), range };
}

function phase(type, event) {
  return { type, ts: event.ts, severity: event.severity, code: event.code, message: event.message };
}

function computeStats(incidents) {
  const bySeverity = { warning: 0, serious: 0, critical: 0 };
  const byDevice = new Map();
  let resolved = 0;
  let resolvedDurationTotal = 0;

  for (const inc of incidents) {
    bySeverity[inc.peakSeverity] = (bySeverity[inc.peakSeverity] ?? 0) + 1;
    byDevice.set(inc.deviceId, (byDevice.get(inc.deviceId) ?? 0) + 1);
    if (inc.resolved) {
      resolved += 1;
      resolvedDurationTotal += inc.durationMs;
    }
  }

  let worstDevice = null;
  for (const [deviceId, count] of byDevice) {
    if (!worstDevice || count > worstDevice.count) worstDevice = { deviceId, count };
  }

  return {
    total: incidents.length,
    resolved,
    unresolved: incidents.length - resolved,
    mttrMs: resolved > 0 ? Math.round(resolvedDurationTotal / resolved) : null,
    bySeverity,
    worstDevice,
  };
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
