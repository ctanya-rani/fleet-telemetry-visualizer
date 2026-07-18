#!/usr/bin/env node
/* Assemble the static demo site into _site/ for GitHub Pages.
 *
 * The site reuses the real dashboard (public/), the real parser and
 * simulator modules, and Leaflet from node_modules — the only demo-specific
 * code is demo-backend.js and the node:events shim. index.html is derived
 * from public/index.html by rewriting absolute asset paths to relative ones
 * (Pages serves the site under /<repo>/) and swapping the server-backed
 * app bootstrap for the in-browser one.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copies = [
  ['public/styles.css', 'styles.css'],
  ['public/app.js', 'app.js'],
  ['src/parser/eventParser.js', 'eventParser.js'],
  ['src/parser/timeline.js', 'timeline.js'],
  ['server/simulator.js', 'simulator.js'],
  ['server/sla.js', 'sla.js'],
  ['demo/demo-backend.js', 'demo-backend.js'],
  ['demo/events-shim.js', 'events-shim.js'],
  ['sample-data/incident-log.jsonl', 'sample-incident-log.jsonl'],
];
for (const [from, to] of copies) cpSync(path.join(root, from), path.join(out, to));
cpSync(path.join(root, 'node_modules/leaflet/dist'), path.join(out, 'vendor/leaflet'), { recursive: true });

let html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
html = html
  .replaceAll('"/vendor/leaflet/', '"vendor/leaflet/')
  .replace('"/styles.css"', '"styles.css"')
  .replace(
    '<h1>Fleet Telemetry</h1>',
    '<h1>Fleet Telemetry</h1><span class="badge" title="All telemetry is generated in your browser by the built-in fleet simulator — no backend.">simulated demo</span>',
  )
  .replace(
    '<script src="/app.js"></script>',
    [
      '<script type="importmap">{"imports":{"node:events":"./events-shim.js"}}</script>',
      '<script type="module" src="demo-backend.js"></script>',
      '<script defer src="app.js"></script>',
    ].join('\n'),
  );

if (html.includes('src="/') || html.includes('href="/')) {
  throw new Error('demo index.html still references an absolute path — Pages serves under /<repo>/');
}
writeFileSync(path.join(out, 'index.html'), html);
writeFileSync(path.join(out, '.nojekyll'), ''); // serve as-is, skip Jekyll
console.log('static demo assembled in _site/');
