import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseEvents, detectFormat, normalizeSeverity, parseTimestamp, splitCsvLine, toErf,
} from '../src/parser/eventParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = (name) => readFileSync(path.join(__dirname, '..', 'sample-data', name), 'utf8');

test('detectFormat recognizes all three formats', () => {
  assert.equal(detectFormat(sample('incident-log.jsonl')), 'jsonl');
  assert.equal(detectFormat(sample('incident-log.csv')), 'csv');
  assert.equal(detectFormat(sample('incident-log.erf')), 'erf');
});

test('normalizeSeverity maps aliases and defaults to info', () => {
  assert.equal(normalizeSeverity('W'), 'warning');
  assert.equal(normalizeSeverity('MAJOR'), 'serious');
  assert.equal(normalizeSeverity('fatal'), 'critical');
  assert.equal(normalizeSeverity('??'), 'info');
  assert.equal(normalizeSeverity(undefined), 'info');
});

test('parseTimestamp handles ISO, epoch seconds, and epoch millis', () => {
  const iso = parseTimestamp('2026-07-16T08:02:11Z');
  assert.equal(iso, Date.UTC(2026, 6, 16, 8, 2, 11));
  assert.equal(parseTimestamp(1784188931), 1784188931000);   // seconds
  assert.equal(parseTimestamp(1784188931000), 1784188931000); // millis
  assert.ok(Number.isNaN(parseTimestamp('not a date')));
});

test('splitCsvLine honors quoted fields with embedded commas and quotes', () => {
  assert.deepEqual(
    splitCsvLine('a,"b, with comma","she said ""hi""",d'),
    ['a', 'b, with comma', 'she said "hi"', 'd'],
  );
});

test('JSONL sample parses fully with normalized fields', () => {
  const { events, errors, format } = parseEvents(sample('incident-log.jsonl'));
  assert.equal(format, 'jsonl');
  assert.equal(errors.length, 0);
  assert.equal(events.length, 18);
  const first = events[0];
  assert.equal(first.deviceId, 'van-03');
  assert.equal(first.type, 'INFO');
  assert.equal(first.severity, 'info');
  assert.ok(events.every((e, i) => i === 0 || e.ts >= events[i - 1].ts), 'events sorted by ts');
});

test('CSV and ERF samples describe the same incidents as JSONL', () => {
  const csv = parseEvents(sample('incident-log.csv'));
  const erf = parseEvents(sample('incident-log.erf'));
  assert.equal(csv.format, 'csv');
  assert.equal(erf.format, 'erf');
  assert.equal(csv.errors.length, 0);
  assert.equal(erf.errors.length, 0);
  assert.equal(csv.events.length, 9);
  assert.equal(erf.events.length, 9);
  assert.deepEqual(
    csv.events.map((e) => [e.deviceId, e.code, e.severity]),
    erf.events.map((e) => [e.deviceId, e.code, e.severity]),
  );
});

test('bad lines are reported, good lines still parse', () => {
  const text = [
    '{"ts":"2026-07-16T08:00:00Z","device":"van-01","type":"FAULT","code":"X","severity":"warning"}',
    'this is not json',
    '{"type":"FAULT","code":"NO_TS_OR_DEVICE"}',
    '{"ts":"2026-07-16T08:05:00Z","device":"van-01","type":"RECOVERY","code":"X_CLEAR","severity":"info"}',
  ].join('\n');
  const { events, errors } = parseEvents(text, { format: 'jsonl' });
  assert.equal(events.length, 2);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.equal(errors[1].line, 3);
});

test('toErf round-trips through the ERF parser', () => {
  const { events } = parseEvents(sample('incident-log.jsonl'));
  const { events: rt, errors } = parseEvents(toErf(events), { format: 'erf' });
  assert.equal(errors.length, 0);
  assert.deepEqual(
    rt.map((e) => [e.ts, e.deviceId, e.type, e.code, e.severity]),
    events.map((e) => [e.ts, e.deviceId, e.type, e.code, e.severity]),
  );
});

test('unknown format throws', () => {
  assert.throws(() => parseEvents('x', { format: 'xml' }), /Unknown format/);
});
