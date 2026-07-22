/* Fleet Telemetry Visualizer — dashboard client.
   Live tab: WebSocket telemetry → Leaflet map + device health + SLA tiles.
   Incidents tab: recorder dump → /api/incidents/parse → SVG timeline. */
'use strict';

// ---------- theme -----------------------------------------------------------

const STATUS = {
  good:     { color: 'var(--status-good)',     hex: '#0ca30c', icon: '●', label: 'Healthy' },
  warning:  { color: 'var(--status-warning)',  hex: '#fab219', icon: '▲', label: 'Warning' },
  serious:  { color: 'var(--status-serious)',  hex: '#ec835a', icon: '◆', label: 'Serious' },
  critical: { color: 'var(--status-critical)', hex: '#d03b3b', icon: '✖', label: 'Critical' },
};

const themeToggle = document.getElementById('theme-toggle');
function currentThemeIsDark() {
  const stamped = document.documentElement.dataset.theme;
  if (stamped) return stamped === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
themeToggle.addEventListener('click', () => {
  document.documentElement.dataset.theme = currentThemeIsDark() ? 'light' : 'dark';
});

// ---------- tabs ------------------------------------------------------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    document.getElementById('tab-live').hidden = btn.dataset.tab !== 'live';
    document.getElementById('tab-incidents').hidden = btn.dataset.tab !== 'incidents';
    if (btn.dataset.tab === 'live') map.invalidateSize();
  });
});

// ---------- tooltip helper ---------------------------------------------------

const tooltip = document.getElementById('tooltip');
function showTooltip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 12;
  const rect = tooltip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  tooltip.style.left = `${Math.max(4, left)}px`;
  tooltip.style.top = `${Math.max(4, top)}px`;
}
function hideTooltip() { tooltip.hidden = true; }

// ---------- map --------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView([37.7749, -122.4194], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const markers = new Map();  // deviceId -> L.circleMarker
const trails = new Map();   // deviceId -> L.polyline

function upsertMarker(d) {
  const spec = STATUS[d.status] ?? STATUS.good;
  let marker = markers.get(d.id);
  if (!marker) {
    marker = L.circleMarker([d.lat, d.lon], {
      radius: 7, weight: 2, color: 'rgba(0,0,0,0.35)',
      fillColor: spec.hex, fillOpacity: 0.95,
    }).addTo(map);
    marker.on('click', () => selectDevice(d.id));
    markers.set(d.id, marker);

    const trail = L.polyline([[d.lat, d.lon]], { color: spec.hex, weight: 2, opacity: 0.35 }).addTo(map);
    trails.set(d.id, trail);
  }
  marker.setLatLng([d.lat, d.lon]);
  marker.setStyle({ fillColor: spec.hex, opacity: d.online ? 1 : 0.4, fillOpacity: d.online ? 0.95 : 0.35 });
  marker.bindTooltip(
    `<strong>${d.id}</strong><br>${spec.icon} ${spec.label}${d.activeFault ? ` — ${d.activeFault.code}` : ''}` +
    `<br>${d.online ? `${d.speedKph} km/h · ${d.latencyMs} ms` : 'offline'}`,
    { direction: 'top', offset: [0, -6] },
  );

  const trail = trails.get(d.id);
  const pts = trail.getLatLngs();
  pts.push(L.latLng(d.lat, d.lon));
  if (pts.length > 40) pts.shift();
  trail.setLatLngs(pts);
  trail.setStyle({ color: spec.hex });
}

// ---------- live state -------------------------------------------------------

const history = new Map();   // deviceId -> {latency:[], battery:[], rssi:[]} of {ts,v}
const fleetHistory = { uptime: [], delivery: [], latency: [] };
const HISTORY_MAX = 240;
let selectedId = null;
let lastDevices = [];
let searchQuery = '';
let activeFilter = 'all';

function pushHistory(list, ts, v) {
  if (v == null || Number.isNaN(v)) return;
  list.push({ ts, v });
  if (list.length > HISTORY_MAX) list.shift();
}

function typeIcon(type) {
  const icons = { van: '🚐', truck: '🚛', drone: '🚁', 'sensor-hub': '📡' };
  return icons[type] ?? '📦';
}

function getFleetStats(devices) {
  const online = devices.filter(d => d.online).length;
  const avgHealth = devices.length > 0
    ? devices.reduce((sum, d) => {
        const healthMap = { good: 100, warning: 70, serious: 40, critical: 10 };
        return sum + (healthMap[d.status] ?? 50);
      }, 0) / devices.length
    : 0;
  const activeFaults = devices.filter(d => d.activeFault).length;
  return { online, avgHealth: Math.round(avgHealth), activeFaults };
}

function onTelemetry(msg) {
  lastDevices = msg.devices;
  for (const d of msg.devices) {
    upsertMarker(d);
    let h = history.get(d.id);
    if (!h) { h = { latency: [], battery: [], rssi: [] }; history.set(d.id, h); }
    pushHistory(h.latency, msg.ts, d.latencyMs);
    pushHistory(h.battery, msg.ts, d.batteryPct);
    pushHistory(h.rssi, msg.ts, d.rssiDbm);
  }
  const f = msg.sla?.fleet;
  if (f && f.samples > 0) {
    pushHistory(fleetHistory.uptime, msg.ts, f.uptimePct);
    pushHistory(fleetHistory.delivery, msg.ts, f.deliveryPct);
    pushHistory(fleetHistory.latency, msg.ts, f.latencyP95Ms);
  }
  renderFleetStats(msg.devices, msg.sla);
  renderSlaTiles(msg.sla);
  renderDeviceList(msg.devices);
  renderDetail();
}

function renderFleetStats(devices, sla) {
  const stats = getFleetStats(devices);
  document.getElementById('stat-total-devices').textContent = devices.length;
  document.getElementById('stat-devices-online').textContent = `${stats.online} online`;
  document.getElementById('stat-active-faults').textContent = stats.activeFaults;
  document.getElementById('stat-avg-health').textContent = `${stats.avgHealth}%`;
  const healthLabel = stats.avgHealth > 80 ? 'excellent' : stats.avgHealth > 60 ? 'good' : stats.avgHealth > 40 ? 'fair' : 'poor';
  document.getElementById('stat-avg-health-sub').textContent = healthLabel;
  const f = sla?.fleet;
  if (f && f.samples > 0) {
    document.getElementById('stat-uptime-sla').textContent = `${f.uptimePct.toFixed(1)}%`;
    const slaBreach = f.breaches.uptime;
    document.getElementById('stat-uptime-sla-sub').textContent = slaBreach ? '⚠ SLO breach' : 'within SLO';
  }
}

// ---------- SLA tiles --------------------------------------------------------

function tileStatus(el, ok, okText, badText) {
  el.innerHTML = ok
    ? `<span class="ok">✓ ${okText}</span>`
    : `<span class="bad">✖ ${badText}</span>`;
}

function renderSlaTiles(sla) {
  const f = sla?.fleet;
  if (!f || f.samples === 0) return;
  const t = sla.targets;

  const up = document.getElementById('tile-uptime');
  up.querySelector('.tile-value').textContent = `${f.uptimePct.toFixed(2)}%`;
  tileStatus(up.querySelector('.tile-status'), !f.breaches.uptime, 'within SLO', 'SLO breach');
  sparkline(up.querySelector('.tile-spark'), fleetHistory.uptime, { min: 90, max: 100 });

  const de = document.getElementById('tile-delivery');
  de.querySelector('.tile-value').textContent = `${f.deliveryPct.toFixed(2)}%`;
  tileStatus(de.querySelector('.tile-status'), !f.breaches.delivery, 'within SLO', 'SLO breach');
  sparkline(de.querySelector('.tile-spark'), fleetHistory.delivery, { min: 90, max: 100 });

  const la = document.getElementById('tile-latency');
  la.querySelector('.tile-value').textContent = f.latencyP95Ms == null ? '—' : `${f.latencyP95Ms} ms`;
  tileStatus(la.querySelector('.tile-status'), !f.breaches.latency, `p95 ≤ ${t.latencyP95Ms} ms`, `p95 > ${t.latencyP95Ms} ms`);
  sparkline(la.querySelector('.tile-spark'), fleetHistory.latency, {});

  const bu = document.getElementById('tile-budget');
  bu.querySelector('.tile-value').textContent = `${f.errorBudgetPct.toFixed(1)}%`;
  const fill = bu.querySelector('.budget-fill');
  fill.style.width = `${Math.max(0, Math.min(100, f.errorBudgetPct))}%`;
  fill.style.background = f.errorBudgetPct > 40 ? 'var(--status-good)'
    : f.errorBudgetPct > 10 ? 'var(--status-warning)' : 'var(--status-critical)';
  tileStatus(bu.querySelector('.tile-status'), f.errorBudgetPct > 10, 'budget healthy', 'budget nearly spent');
}

// ---------- sparklines (single series, blue; hover = nearest-point dot) ------

function sparkline(svg, points, { min, max } = {}) {
  const vb = svg.viewBox.baseVal;
  const W = vb.width, H = vb.height;
  svg.replaceChildren();
  if (points.length < 2) return;

  const vals = points.map((p) => p.v);
  let lo = min ?? Math.min(...vals);
  let hi = max ?? Math.max(...vals);
  if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const x = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2;
  const y = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);

  const base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  base.setAttribute('x1', 2); base.setAttribute('x2', W - 2);
  base.setAttribute('y1', H - 3); base.setAttribute('y2', H - 3);
  base.setAttribute('stroke', 'var(--baseline)'); base.setAttribute('stroke-width', '1');
  svg.appendChild(base);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(''));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--series-1)');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('r', '3');
  dot.setAttribute('fill', 'var(--series-1)');
  dot.setAttribute('visibility', 'hidden');
  svg.appendChild(dot);

  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const ts = t0 + ((ev.clientX - rect.left) / rect.width) * (t1 - t0);
    let nearest = points[0];
    for (const p of points) if (Math.abs(p.ts - ts) < Math.abs(nearest.ts - ts)) nearest = p;
    dot.setAttribute('cx', x(nearest.ts));
    dot.setAttribute('cy', y(nearest.v));
    dot.setAttribute('visibility', 'visible');
    showTooltip(
      `<div class="tt-title">${fmtNum(nearest.v)}</div><div class="tt-row">${new Date(nearest.ts).toLocaleTimeString()}</div>`,
      ev.clientX, ev.clientY,
    );
  };
  svg.onmouseleave = () => { dot.setAttribute('visibility', 'hidden'); hideTooltip(); };
}

const fmtNum = (v) => (Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1));

// ---------- device list & detail ---------------------------------------------

function badge(status) {
  const s = STATUS[status] ?? STATUS.good;
  return `<span class="badge"><span class="badge-ico" style="color:${s.color}">${s.icon}</span>${s.label}</span>`;
}

function renderDeviceList(devices) {
  const counts = { good: 0, warning: 0, serious: 0, critical: 0 };
  for (const d of devices) counts[d.status] = (counts[d.status] ?? 0) + 1;
  document.getElementById('fleet-counts').textContent =
    `${devices.length} units · ${counts.critical} critical · ${counts.serious + counts.warning} degraded`;

  let filtered = devices.filter(d => {
    const matchesSearch = !searchQuery || d.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter =
      activeFilter === 'all' ? true :
      activeFilter === 'online' ? d.online :
      activeFilter === 'faults' ? d.activeFault : true;
    return matchesSearch && matchesFilter;
  });

  const ul = document.getElementById('device-list');
  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  const sorted = [...filtered].sort((a, b) => (order[a.status] - order[b.status]) || a.id.localeCompare(b.id));

  ul.replaceChildren(...sorted.map((d) => {
    const li = document.createElement('li');
    li.className = 'device-row' + (d.id === selectedId ? ' selected' : '');
    const s = STATUS[d.status] ?? STATUS.good;
    li.innerHTML = `
      <span class="device-dot" style="background:${s.color}"></span>
      <span>
        <span class="device-name">${typeIcon(d.type)} ${d.id}</span>
        <span class="device-sub">${d.online ? `${d.latencyMs} ms · ${d.batteryPct}%` : 'offline'}${d.activeFault ? ` · ${d.activeFault.code}` : ''}</span>
      </span>
      ${badge(d.status)}`;
    li.addEventListener('click', () => selectDevice(d.id));
    return li;
  }));
}

function selectDevice(id) {
  selectedId = selectedId === id ? null : id;
  document.getElementById('device-detail').hidden = selectedId === null;
  if (selectedId) {
    const d = lastDevices.find((x) => x.id === selectedId);
    if (d) map.panTo([d.lat, d.lon]);
  }
  renderDeviceList(lastDevices);
  renderDetail();
}
document.getElementById('detail-close').addEventListener('click', () => selectDevice(selectedId));

function renderDetail() {
  if (!selectedId) return;
  const d = lastDevices.find((x) => x.id === selectedId);
  const h = history.get(selectedId);
  if (!d || !h) return;

  document.getElementById('detail-title').textContent = `${d.id} (${d.type})`;
  document.getElementById('detail-badges').innerHTML =
    badge(d.status) + (d.activeFault ? ` <span class="badge">${d.activeFault.code}</span>` : '');

  sparkline(document.getElementById('spark-latency'), h.latency, {});
  sparkline(document.getElementById('spark-battery'), h.battery, { min: 0, max: 100 });
  sparkline(document.getElementById('spark-rssi'), h.rssi, {});

  const sla = d.sla ?? {};
  const facts = [
    ['Status', `${STATUS[d.status].label}${d.online ? '' : ' (offline)'}`],
    ['Position', `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`],
    ['Speed', `${d.speedKph} km/h`],
    ['Engine temp', `${d.engineTempC} °C`],
    ['Uptime (15 m)', sla.uptimePct == null ? '—' : `${sla.uptimePct}%`],
    ['Delivery (15 m)', sla.deliveryPct == null ? '—' : `${sla.deliveryPct}%`],
    ['Latency p95', sla.latencyP95Ms == null ? '—' : `${sla.latencyP95Ms} ms`],
    ['Error budget', sla.errorBudgetPct == null ? '—' : `${sla.errorBudgetPct}%`],
  ];
  document.getElementById('detail-facts').innerHTML =
    facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------- device search & filtering ----------------------------------------

document.getElementById('device-search').addEventListener('input', (ev) => {
  searchQuery = ev.target.value;
  renderDeviceList(lastDevices);
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderDeviceList(lastDevices);
  });
});

// ---------- WebSocket ---------------------------------------------------------

const connEl = document.getElementById('conn');
function setConn(on) {
  connEl.className = `conn ${on ? 'conn-on' : 'conn-off'}`;
  const connText = on ? 'live' : 'reconnecting…';
  const dot = document.querySelector('.conn-dot');
  if (dot) dot.parentElement.textContent = '';
  connEl.innerHTML = `<span class="conn-dot" aria-hidden="true"></span><span id="conn-text">${connText}</span>`;
}

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 30;
const RECONNECT_DELAY = 2000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setConn(true);
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'telemetry') onTelemetry(msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };

  ws.onclose = () => {
    setConn(false);
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(connect, RECONNECT_DELAY);
    }
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
    ws.close();
  };
}
connect();

// ================= Incident Timeline tab =====================================

const SEV_SPEC = {
  warning:  STATUS.warning,
  serious:  STATUS.serious,
  critical: STATUS.critical,
};

const pasteArea = document.getElementById('paste-area');
const parseNote = document.getElementById('parse-note');

document.getElementById('btn-parse').addEventListener('click', () => analyzeText(pasteArea.value));
document.getElementById('btn-live-buffer').addEventListener('click', async () => {
  parseNote.textContent = 'fetching live recorder buffer…';
  const res = await fetch('api/incidents/live');
  renderTimelineResult(await res.json());
});
document.getElementById('btn-sample').addEventListener('click', async () => {
  const res = await fetch('sample-incident-log.jsonl');
  const text = await res.text();
  pasteArea.value = text;
  analyzeText(text);
});
document.getElementById('file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const text = await file.text();
  pasteArea.value = text;
  analyzeText(text);
});

async function analyzeText(text) {
  if (!text.trim()) { parseNote.textContent = 'nothing to parse — paste a dump or open a file'; return; }
  parseNote.textContent = 'parsing…';
  try {
    const res = await fetch('api/incidents/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });
    const data = await res.json();
    if (!res.ok) {
      parseNote.textContent = `⚠ ${data.error || 'parsing failed'}`;
      return;
    }
    renderTimelineResult(data);
  } catch (e) {
    parseNote.textContent = `⚠ network error: ${e.message}`;
    console.error('Parse error:', e);
  }
}

function renderTimelineResult(data) {
  const { incidents, stats, range, format, eventCount, parseErrors } = data;
  parseNote.textContent = `${eventCount} events (${format})` +
    (parseErrors.length ? `, ${parseErrors.length} line(s) skipped` : '') +
    ` → ${incidents.length} incident(s)`;
  document.getElementById('inc-results').hidden = false;

  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-total-sub').textContent =
    `warning ${stats.bySeverity.warning ?? 0} · serious ${stats.bySeverity.serious ?? 0} · critical ${stats.bySeverity.critical ?? 0}`;
  document.getElementById('stat-resolved').textContent = `${stats.resolved}/${stats.total}`;
  document.getElementById('stat-resolved-sub').textContent = stats.unresolved ? `${stats.unresolved} still open` : 'all recovered';
  document.getElementById('stat-mttr').textContent = fmtDur(stats.mttrMs);
  document.getElementById('stat-worst').textContent = stats.worstDevice?.deviceId ?? '—';
  document.getElementById('stat-worst-sub').textContent = stats.worstDevice ? `${stats.worstDevice.count} incident(s)` : '';

  renderTimelineSvg(incidents, range);
  renderIncidentCards(incidents);

  const errBox = document.getElementById('parse-errors-box');
  errBox.hidden = parseErrors.length === 0;
  document.getElementById('parse-errors').innerHTML =
    parseErrors.slice(0, 50).map((e) => `<li>line ${e.line}: ${e.reason}</li>`).join('');
}

function renderTimelineSvg(incidents, range) {
  const svg = document.getElementById('timeline-svg');
  svg.replaceChildren();
  if (!range || incidents.length === 0) return;

  const legend = document.getElementById('timeline-legend');
  legend.innerHTML = Object.entries(SEV_SPEC)
    .map(([sev, s]) => `<span class="key"><span class="swatch" style="background:${s.color}"></span>${s.icon} ${sev}</span>`)
    .join('') + `<span class="key"><span class="swatch" style="background:var(--grid)"></span>unresolved (open end)</span>`;

  const LABEL_W = 190, ROW_H = 26, PAD_T = 24, PAD_R = 16, PLOT_W = 760;
  const W = LABEL_W + PLOT_W + PAD_R;
  const H = PAD_T + incidents.length * ROW_H + 22;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  const span = Math.max(1, range.end - range.start);
  const x = (ts) => LABEL_W + ((ts - range.start) / span) * PLOT_W;
  const el = (tag, attrs, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  };

  // time axis: ~6 gridlines
  for (let i = 0; i <= 5; i++) {
    const ts = range.start + (span * i) / 5;
    const gx = x(ts);
    svg.appendChild(el('line', { x1: gx, y1: PAD_T - 6, x2: gx, y2: H - 20, stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.appendChild(el('text', {
      x: gx, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 5 ? 'end' : 'middle',
      fill: 'var(--muted)', 'font-size': 10.5,
    }, new Date(ts).toLocaleTimeString()));
  }

  incidents.forEach((inc, row) => {
    const yTop = PAD_T + row * ROW_H;
    const yMid = yTop + ROW_H / 2;
    const spec = SEV_SPEC[inc.peakSeverity] ?? SEV_SPEC.warning;

    svg.appendChild(el('text', {
      x: LABEL_W - 10, y: yMid + 3.5, 'text-anchor': 'end',
      fill: 'var(--text-secondary)', 'font-size': 11.5,
    }, `${inc.id} · ${inc.deviceId}`));

    const x0 = x(inc.start);
    const x1 = Math.max(x0 + 3, x(inc.end ?? range.end));
    const bar = el('rect', {
      x: x0, y: yMid - 5, width: x1 - x0, height: 10, rx: 4,
      fill: spec.color, stroke: 'var(--surface-1)', 'stroke-width': 2,
    });
    if (!inc.resolved) bar.setAttribute('opacity', '0.55');
    svg.appendChild(bar);

    for (const p of inc.phases) {
      if (p.type === 'escalated') {
        svg.appendChild(el('path', {
          d: `M${x(p.ts)},${yMid - 9} l4,7 h-8 z`, fill: spec.color,
          stroke: 'var(--surface-1)', 'stroke-width': 1.5,
        }));
      }
    }
    if (inc.resolved) {
      svg.appendChild(el('circle', {
        cx: x1, cy: yMid, r: 4.5, fill: 'var(--surface-1)',
        stroke: spec.color, 'stroke-width': 2,
      }));
    }

    // invisible hover target spanning the row
    const hit = el('rect', { x: LABEL_W, y: yTop, width: PLOT_W, height: ROW_H, fill: 'transparent' });
    hit.addEventListener('mousemove', (ev) => showTooltip(incidentTooltip(inc), ev.clientX, ev.clientY));
    hit.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(hit);
  });
}

function incidentTooltip(inc) {
  const spec = SEV_SPEC[inc.peakSeverity];
  return `<div class="tt-title">${inc.id} · ${escapeHtml(inc.deviceId)}</div>
    <div class="tt-row">${spec.icon} peak ${inc.peakSeverity} — ${escapeHtml(inc.rootCause.code)}</div>
    <div class="tt-row">${fmtTs(inc.start)} → ${inc.resolved ? fmtTs(inc.end) : 'open'}</div>
    <div class="tt-row">duration ${fmtDur(inc.durationMs)} · ${inc.events.length} events</div>`;
}

function renderIncidentCards(incidents) {
  const host = document.getElementById('incident-cards');
  host.replaceChildren(...incidents.map((inc) => {
    const spec = SEV_SPEC[inc.peakSeverity] ?? SEV_SPEC.warning;
    const details = document.createElement('details');
    details.className = 'inc-card';
    details.innerHTML = `
      <summary>
        <span class="inc-id">${inc.id}</span>
        <span>${escapeHtml(inc.deviceId)}</span>
        <span class="badge"><span class="badge-ico" style="color:${spec.color}">${spec.icon}</span>${inc.peakSeverity}</span>
        <span class="muted">${escapeHtml(inc.rootCause.code)}${inc.resolved ? '' : ' · UNRESOLVED'}</span>
        <span class="inc-time">${fmtTs(inc.start)} · ${fmtDur(inc.durationMs)}</span>
      </summary>
      <ul class="inc-phases">
        ${inc.phases.map((p) => `
          <li>
            <span class="ph-ts">${fmtTs(p.ts)}</span>
            <span class="ph-type">${p.type}</span>
            <span>${escapeHtml(p.code) || p.severity}${p.message ? ` — ${escapeHtml(p.message)}` : ''}</span>
          </li>`).join('')}
      </ul>`;
    return details;
  }));
}

// ---------- misc formatters ---------------------------------------------------

function fmtTs(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
