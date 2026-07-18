#!/usr/bin/env node
/**
 * fleet-recorder — parse an event-recorder dump and reconstruct the
 * incident timeline in the terminal.
 *
 * Usage:
 *   fleet-recorder <file> [--format jsonl|csv|erf] [--gap <minutes>]
 *                         [--device <id>] [--json] [--width <cols>]
 *
 * Reads stdin when <file> is "-".
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseEvents } from './eventParser.js';
import { reconstructTimeline, formatDuration, DEFAULT_GAP_MS } from './timeline.js';

function parseArgs(argv) {
  const opts = { file: null, format: 'auto', gapMs: DEFAULT_GAP_MS, device: null, json: false, width: 64 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format') opts.format = argv[++i];
    else if (arg === '--gap') opts.gapMs = Number(argv[++i]) * 60_000;
    else if (arg === '--device') opts.device = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--width') opts.width = Math.max(20, Number(argv[++i]) || 64);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else if (!opts.file) opts.file = arg;
    else { console.error(`Unexpected argument: ${arg}`); usage(); process.exit(2); }
  }
  if (!opts.file) { usage(); process.exit(2); }
  if (!Number.isFinite(opts.gapMs) || opts.gapMs <= 0) {
    console.error('--gap must be a positive number of minutes');
    process.exit(2);
  }
  return opts;
}

function usage() {
  console.error('Usage: fleet-recorder <file|-> [--format jsonl|csv|erf] [--gap <minutes>] [--device <id>] [--json] [--width <cols>]');
}

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

const SEV_TAG = { warning: 'WARN', serious: 'SERIOUS', critical: 'CRITICAL', info: 'INFO' };

function renderAsciiTimeline(timeline, width) {
  const { incidents, range } = timeline;
  if (!range || incidents.length === 0) return '';
  const span = Math.max(1, range.end - range.start);
  const scale = (ts) => Math.min(width - 1, Math.max(0, Math.round(((ts - range.start) / span) * (width - 1))));

  const label = (inc) => `${inc.id} ${inc.deviceId}`;
  const labelWidth = Math.max(...incidents.map((i) => label(i).length)) + 2;

  const lines = [];
  lines.push(`${' '.repeat(labelWidth)}${fmtTime(range.start)}${' '.repeat(Math.max(1, width - 40))}${fmtTime(range.end)}`);
  for (const inc of incidents) {
    const row = new Array(width).fill('·');
    const a = scale(inc.start);
    const b = scale(inc.end ?? range.end);
    for (let i = a; i <= b; i++) row[i] = '=';
    row[a] = '!';
    for (const p of inc.phases) {
      if (p.type === 'escalated') row[scale(p.ts)] = '^';
    }
    if (inc.resolved) row[b] = 'v';
    lines.push(label(inc).padEnd(labelWidth) + row.join(''));
  }
  lines.push('');
  lines.push(`${' '.repeat(labelWidth)}legend: ! detected   ^ escalated   v recovered   = active   · idle`);
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const text = opts.file === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.file, 'utf8');

  const { events, errors, format } = parseEvents(text, { format: opts.format });
  const filtered = opts.device ? events.filter((e) => e.deviceId === opts.device) : events;
  const timeline = reconstructTimeline(filtered, { gapMs: opts.gapMs });

  if (opts.json) {
    console.log(JSON.stringify({ format, eventCount: filtered.length, parseErrors: errors, ...timeline }, null, 2));
    return;
  }

  const { incidents, stats, range } = timeline;
  console.log(`Parsed ${filtered.length} events (format: ${format})` +
    (errors.length ? `, ${errors.length} bad line(s) skipped` : ''));
  if (errors.length) {
    for (const err of errors.slice(0, 5)) console.log(`  line ${err.line}: ${err.reason}`);
    if (errors.length > 5) console.log(`  … and ${errors.length - 5} more`);
  }
  if (!range || incidents.length === 0) {
    console.log('No incidents reconstructed.');
    return;
  }

  console.log(`Window: ${fmtTime(range.start)} → ${fmtTime(range.end)}`);
  console.log(`Incidents: ${stats.total} (${stats.resolved} resolved, ${stats.unresolved} unresolved)` +
    `  MTTR: ${formatDuration(stats.mttrMs)}` +
    (stats.worstDevice ? `  Worst device: ${stats.worstDevice.deviceId} (${stats.worstDevice.count})` : ''));
  console.log('');
  console.log(renderAsciiTimeline(timeline, opts.width));
  console.log('');

  for (const inc of incidents) {
    console.log(`${inc.id}  ${inc.deviceId}  [${SEV_TAG[inc.peakSeverity]}]  ${inc.rootCause.code}` +
      `  ${fmtTime(inc.start)}  duration ${formatDuration(inc.durationMs)}` +
      (inc.resolved ? '' : '  (UNRESOLVED)'));
    for (const p of inc.phases) {
      const tag = { detected: 'detected ', escalated: 'escalated', recovered: 'recovered', activity: 'activity ', annotation: 'note     ' }[p.type];
      console.log(`    ${fmtTime(p.ts)}  ${tag}  ${p.code || p.severity}${p.message ? ` — ${p.message}` : ''}`);
    }
  }
}

main();
