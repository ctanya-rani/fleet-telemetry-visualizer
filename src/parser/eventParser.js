/**
 * Event-recorder data parser.
 *
 * Accepts the three formats fleet event recorders commonly export and
 * normalizes every record to a single Event shape:
 *
 *   { ts, deviceId, type, code, severity, message, raw }
 *
 *   ts        epoch milliseconds (number)
 *   deviceId  string
 *   type      FAULT | RECOVERY | INFO | ... (uppercased free-form)
 *   code      machine code, e.g. ENG_TEMP_HIGH
 *   severity  info | warning | serious | critical
 *   message   human-readable text (may be empty)
 *   raw       the source line, kept for debugging
 *
 * Supported formats:
 *   jsonl  one JSON object per line, flexible key names
 *   csv    header row required, flexible column names
 *   erf    pipe-framed recorder dump: epochMs|device|TYPE|CODE|SEV|message
 *          (optional "#ERF1" header line, "#" comments allowed)
 */

export const SEVERITIES = ['info', 'warning', 'serious', 'critical'];

const SEVERITY_ALIASES = {
  i: 'info', info: 'info', informational: 'info', notice: 'info', ok: 'info',
  w: 'warning', warn: 'warning', warning: 'warning', minor: 'warning',
  s: 'serious', serious: 'serious', major: 'serious', error: 'serious', err: 'serious',
  c: 'critical', critical: 'critical', crit: 'critical', fatal: 'critical',
  emergency: 'critical',
};

export function severityRank(severity) {
  const i = SEVERITIES.indexOf(severity);
  return i === -1 ? 0 : i;
}

export function normalizeSeverity(value) {
  if (value == null) return 'info';
  const key = String(value).trim().toLowerCase();
  return SEVERITY_ALIASES[key] ?? 'info';
}

export function parseTimestamp(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return normalizeEpoch(value);
  const str = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return normalizeEpoch(Number(str));
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? NaN : parsed;
}

// Accepts epoch seconds or milliseconds and returns milliseconds.
// Anything below 1e12 (before ~2001 as ms) is treated as seconds.
function normalizeEpoch(n) {
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** Guess the format of a recorder dump from its content. */
export function detectFormat(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 'jsonl';
  if (lines[0].startsWith('#ERF')) return 'erf';

  const sample = lines.filter((l) => !l.startsWith('#')).slice(0, 20);
  const score = { jsonl: 0, csv: 0, erf: 0 };
  for (const line of sample) {
    if (line.startsWith('{')) score.jsonl++;
    else if (line.split('|').length >= 5) score.erf++;
    else if (line.split(',').length >= 3) score.csv++;
  }
  let best = 'jsonl';
  for (const fmt of ['csv', 'erf']) if (score[fmt] > score[best]) best = fmt;
  return best;
}

/**
 * Parse a recorder dump into normalized events.
 * Returns { events, errors, format }. Bad lines are collected in `errors`
 * (with line numbers) instead of aborting the whole parse.
 */
export function parseEvents(text, { format = 'auto' } = {}) {
  const fmt = format === 'auto' ? detectFormat(text) : format;
  const parsers = { jsonl: parseJsonl, csv: parseCsv, erf: parseErf };
  const parser = parsers[fmt];
  if (!parser) throw new Error(`Unknown format "${fmt}" (expected jsonl, csv, or erf)`);
  const { events, errors } = parser(String(text));
  events.sort((a, b) => a.ts - b.ts);
  return { events, errors, format: fmt };
}

function makeEvent({ ts, deviceId, type, code, severity, message, raw }) {
  return {
    ts,
    deviceId: String(deviceId).trim(),
    type: String(type ?? 'INFO').trim().toUpperCase() || 'INFO',
    code: String(code ?? '').trim().toUpperCase(),
    severity: normalizeSeverity(severity),
    message: String(message ?? '').trim(),
    raw,
  };
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function parseJsonl(text) {
  const events = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      errors.push({ line: i + 1, reason: 'invalid JSON', raw: trimmed });
      return;
    }
    const ts = parseTimestamp(pick(obj, ['ts', 'timestamp', 'time', 't', 'date']));
    const deviceId = pick(obj, ['deviceId', 'device_id', 'device', 'unit', 'source', 'id']);
    if (Number.isNaN(ts) || !deviceId) {
      errors.push({ line: i + 1, reason: 'missing timestamp or device id', raw: trimmed });
      return;
    }
    events.push(makeEvent({
      ts,
      deviceId,
      type: pick(obj, ['type', 'event_type', 'eventType', 'event']),
      code: pick(obj, ['code', 'fault_code', 'faultCode', 'dtc']),
      severity: pick(obj, ['severity', 'sev', 'level']),
      message: pick(obj, ['message', 'msg', 'description', 'text']),
      raw: trimmed,
    }));
  });
  return { events, errors };
}

// Minimal CSV field splitter with double-quote support ("" escapes a quote).
export function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

const CSV_COLUMNS = {
  ts: ['timestamp', 'ts', 'time', 'datetime', 'date'],
  deviceId: ['device_id', 'deviceid', 'device', 'unit', 'unit_id', 'source', 'id'],
  type: ['event_type', 'eventtype', 'type', 'event'],
  code: ['code', 'fault_code', 'faultcode', 'dtc'],
  severity: ['severity', 'sev', 'level'],
  message: ['message', 'msg', 'description', 'text'],
};

function parseCsv(text) {
  const events = [];
  const errors = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { events, errors };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const index = {};
  for (const [field, aliases] of Object.entries(CSV_COLUMNS)) {
    index[field] = header.findIndex((h) => aliases.includes(h));
  }
  if (index.ts === -1 || index.deviceId === -1) {
    errors.push({ line: 1, reason: 'CSV header missing timestamp or device column', raw: lines[0] });
    return { events, errors };
  }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#')) continue;
    const cols = splitCsvLine(lines[i]);
    const get = (field) => (index[field] >= 0 ? cols[index[field]] : undefined);
    const ts = parseTimestamp(get('ts'));
    const deviceId = get('deviceId');
    if (Number.isNaN(ts) || !deviceId) {
      errors.push({ line: i + 1, reason: 'missing timestamp or device id', raw: lines[i] });
      continue;
    }
    events.push(makeEvent({
      ts,
      deviceId,
      type: get('type'),
      code: get('code'),
      severity: get('severity'),
      message: get('message'),
      raw: lines[i],
    }));
  }
  return { events, errors };
}

function parseErf(text) {
  const events = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('|');
    if (parts.length < 5) {
      errors.push({ line: i + 1, reason: 'expected epochMs|device|TYPE|CODE|SEV|message', raw: trimmed });
      return;
    }
    const [tsRaw, deviceId, type, code, sev, ...msg] = parts;
    const ts = parseTimestamp(tsRaw);
    if (Number.isNaN(ts) || !deviceId.trim()) {
      errors.push({ line: i + 1, reason: 'bad timestamp or device id', raw: trimmed });
      return;
    }
    events.push(makeEvent({
      ts,
      deviceId,
      type,
      code,
      severity: sev,
      message: msg.join('|'),
      raw: trimmed,
    }));
  });
  return { events, errors };
}

/** Serialize normalized events back to the ERF framed format. */
export function toErf(events) {
  const sevCode = { info: 'I', warning: 'W', serious: 'S', critical: 'C' };
  const lines = ['#ERF1'];
  for (const e of events) {
    lines.push([e.ts, e.deviceId, e.type, e.code, sevCode[e.severity] ?? 'I', e.message].join('|'));
  }
  return lines.join('\n') + '\n';
}
