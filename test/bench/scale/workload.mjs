import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { iconKeys, init, parseWorkerToHost, portName, SESSION_VERSION, step } from '../../../src/core/index.ts';
import { createIcons, deliverIcons } from '../../../src/worker/adapters/icons/index.ts';
import { MOVES, SEARCH_KEYS } from '../journey.mjs';

export const SIZES = [
  { rows: 100, windows: 1 },
  { rows: 1000, windows: 10 },
  { rows: 3000, windows: 30 },
];

export const MOVES_STAGES = Array.from({ length: MOVES }, (_, i) => ({
  id: 'move' + (i + 1),
  label: 'Arrow Down ' + (i + 1),
  key: 'ArrowDown',
}));

export const SEARCH_STAGES = SEARCH_KEYS.map((key, i) => ({
  id: 'search' + (i + 1),
  label: 'Search key ' + key.toUpperCase(),
  key,
  query: SEARCH_KEYS.slice(0, i + 1).join(''),
}));

const PAGES = [
  ['Alpha rollout checklist | Engineering', 'docs', 'projects/alpha/releases/checklist'],
  ['Service latency review | Observability', 'metrics', 'dashboards/alpha-p95/summary'],
  ['Atlas navigation and routing | Design', 'design', 'teams/atlas/specs/navigation'],
  ['Help center search results | Support', 'help', 'kb/search/setup'],
  ['Alpine deployment guide | Infrastructure', 'ci', 'pipelines/alpine/build-guide'],
  ['Équipe planning notes | Calendar', 'calendar', 'events/planning/recap'],
  ['CSS Grid sizing patterns | Reference', 'learn', 'guides/css/grid/sizing'],
  ['Budget forecast and actuals | Finance', 'finance', 'reports/current-quarter'],
  ['Incident résumé and timeline | Operations', 'status', 'incidents/notification-delay'],
  ['Quarterly workbook | Customer Success', 'sheets', 'workbooks/customer/renewals'],
  ['メトリクスと通知 | SRE', 'ops', 'metrics/notification-errors'],
  ['Pull requests to review | Git', 'git', 'repos/client/pulls/review'],
];

function tabOf(index, active) {
  const [title, site, topic] = PAGES[index % PAGES.length];
  const tabId = index + 1;
  const origin = 'https://' + site + '.orbit.test';
  const url = origin + '/' + topic + '/' + tabId + '?view=overview&rev=' + (index % 7);
  return {
    tabId,
    title: title + ' · ' + tabId,
    url,
    pinned: index % 17 === 0,
    audible: index % 43 === 0,
    active,
    iconKey: origin + '/favicon.ico\n' + url,
  };
}

function fixture({ rows, windows }) {
  const perWindow = rows / windows;
  const live = {
    windows: Array.from({ length: windows }, (_, w) => ({
      windowId: w + 1,
      tabs: Array.from({ length: perWindow }, (_, i) => tabOf(w * perWindow + i, i === 0)),
    })),
  };
  const envelope = {
    version: SESSION_VERSION,
    windows: live.windows.map(({ windowId }) => [windowId, rows + windowId]),
    tabs: live.windows.flatMap(({ windowId, tabs }) =>
      tabs
        .filter(({ tabId }) => tabId % 7 !== 0)
        .map(({ tabId }) => [tabId, windowId, (((tabId - 1) * 137) % rows) + 1]),
    ),
  };
  const { tabId, url } = live.windows[0].tabs[0];
  return { live, envelope, source: { tabId, windowId: 1, url } };
}

export function hostFrame(model, input) {
  const next = step(model, { at: 2, kind: 'host', attempt: model.interaction.attempt.id, input });
  const render = next.effects.find((effect) => effect.kind === 'render');
  assert(render, 'The core did not emit the expected frame');
  return { model: next.model, message: { t: 'frame', frame: render.frame } };
}

const pngChunk = (type, bytes) => {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const header = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([header, data, checksum]);
};

// Each synthetic favicon is a 32 px PNG with a different pattern and identical dimensions.
function favicon(seed) {
  const size = 32;
  const header = Buffer.from([0, 0, 0, size, 0, 0, 0, size, 8, 2, 0, 0, 0]);
  const stride = size * 3 + 1;
  const pixels = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = (y >> 1) * 16 + (x >> 1);
      const color = Math.imul(seed * 256 + cell, 0x45d9f3b);
      pixels.writeUIntBE((color ^ (color >>> 13)) & 0xffffff, y * stride + 1 + x * 3, 3);
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

export async function iconDelivery({ keys, iconsByPage }) {
  let reads = 0;
  let globeReads = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const read = (page) => {
    if (page === 'about:blank') globeReads++;
    else reads++;
    peakInFlight = Math.max(peakInFlight, ++inFlight);
    return Promise.resolve(iconsByPage.get(page) ?? null).finally(() => {
      inFlight--;
    });
  };
  const { promise, resolve } = Promise.withResolvers();
  const source = createIcons(read);
  const start = performance.now();
  deliverIcons(source, keys, (icons) => {
    resolve({ icons, reads, globeReads, peakInFlight, ms: performance.now() - start });
  });
  return await promise;
}

export function makeWorkload(size) {
  const { live, envelope, source } = fixture(size);
  const model = init('scale', envelope, undefined, live).model;
  const opened = step(model, { kind: 'searchCommand', source, live, binding: null, closed: [], at: 0 });
  const mount = opened.effects.find((effect) => effect.kind === 'mountOverlay');
  assert(mount, 'The core did not open the synthetic overlay');
  const start = { t: 'start', start: mount.start, wake: null };
  const ready = step(opened.model, { kind: 'hostStatus', attempt: mount.attempt, status: 'ready', at: 1 });
  const keys = iconKeys(ready.model.interaction.snapshot);
  const iconsByPage = new Map(live.windows.flatMap(({ tabs }) => tabs.map(({ tabId, url }) => [url, favicon(tabId)])));
  assert(start.start.frame.results.length === size.rows, 'The start view omitted synthetic rows');
  return {
    ...size,
    live,
    envelope,
    source,
    model: ready.model,
    start,
    name: portName(mount.attempt),
    keys,
    iconsByPage,
  };
}

export function overlayWorkload(work, icons) {
  let model = work.model;
  const inputs = [...MOVES_STAGES, ...SEARCH_STAGES].map((stage) => {
    const input = stage.query ? { kind: 'query', text: stage.query } : { kind: 'move', delta: 1 };
    const next = hostFrame(model, input);
    model = next.model;
    return { id: stage.id, input, message: next.message };
  });
  return { name: work.name, start: work.start, inputs, icons };
}

export function wire(message, shape) {
  const text = JSON.stringify(message);
  const decoded = JSON.parse(text);
  assert(parseWorkerToHost(decoded, shape)?.t === message.t, 'Synthetic message failed protocol validation');
  return { text, decoded, bytes: Buffer.byteLength(text) };
}
