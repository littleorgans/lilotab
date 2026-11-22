import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSnapshot,
  globalList,
  iconKeys,
  listView,
  parseWorkerToHost,
  project,
  readEnvelope,
  reconcile,
  shapeOf,
  tabActivated,
} from '../../../src/core/index.ts';
import { startView } from '../../../src/core/interaction/run.ts';
import { searchOf } from '../../../src/core/interaction/selection.ts';
import { within } from '../../chrome/support.mjs';
import { load } from '../runtime.mjs';
import { hotFunctions } from '../trace.mjs';
import { summarize } from './report.mjs';
import { SEARCH_STAGES, hostFrame, iconDelivery, makeWorkload, overlayWorkload, wire } from './workload.mjs';

export const CORE_WARMUP = 40;
export const CORE_RUNS = 80;
const PROFILE_MS = 250;

const move = { kind: 'move', delta: 1 };
const stage = (id, label, run, batch = 1) => ({ id, label, run, batch });
let value;

function operations(work, start, arrow, icon, shape) {
  const { live, source, envelope, model } = work;
  const { recents, settings, interaction } = model;
  return [
    stage('hydrate', 'Recents hydrate', () => readEnvelope(envelope)),
    stage('reconcile', 'Recents reconcile', () => reconcile(recents, live)),
    stage('recentOrder', 'Recents global order', () => globalList(recents)),
    stage('activate', 'Recents tab activation', () =>
      tabActivated(recents, live.windows[0].tabs[1].tabId, source.windowId),
    ),
    stage('checkpoint', 'Recents checkpoint projection', () => project(recents)),
    stage('snapshot', 'Snapshot build', () => buildSnapshot(recents, live, settings, source, [])),
    stage('projection', 'List view projection', () => listView(interaction.snapshot)),
    stage('searchEmpty', 'Rank empty search', () => searchOf(interaction, '', interaction.cursor)),
    stage('startBuild', 'Start message build', () => ({ t: 'start', start: startView(interaction), wake: null })),
    stage('startEncode', 'Start JSON encode', function encodeStart() {
      return JSON.stringify(work.start);
    }),
    stage('startDecode', 'Start JSON decode', () => JSON.parse(start.text)),
    stage('startValidate', 'Start validation', () => parseWorkerToHost(start.decoded, null)),
    ...SEARCH_STAGES.map(({ id, label, query }) =>
      stage(id, label + ' ranking', () => searchOf(interaction, query, null)),
    ),
    stage('moveBuild', 'Move frame build', () => hostFrame(model, move), 32),
    stage('moveEncode', 'Move JSON encode', () => JSON.stringify(arrow.decoded)),
    stage('moveDecode', 'Move JSON decode', () => JSON.parse(arrow.text)),
    stage('moveValidate', 'Move frame validation', () => parseWorkerToHost(arrow.decoded, shape)),
    stage('iconKeys', 'Favicon key projection', () => iconKeys(interaction.snapshot)),
    stage('iconValidate', 'Favicon patch validation', () => parseWorkerToHost(icon.decoded, shape)),
    { ...stage('iconDelivery', 'Favicon fan out to patch', () => iconDelivery(work)), async: true },
  ];
}

function invoke({ batch, run }) {
  for (let i = 0; i < batch; i++) value = run();
}

export async function prepareCase(size) {
  const work = makeWorkload(size);
  const { icons, reads, globeReads, peakInFlight } = await within(
    5000,
    () => iconDelivery(work),
    'Synthetic favicon delivery',
  );
  assert(reads === size.rows && globeReads === 1 && icons.length === size.rows, 'Unexpected favicon fan out');
  const overlay = overlayWorkload(work, { t: 'icons', icons });
  const shape = shapeOf(work.start.start.view);
  const start = wire(work.start, null);
  const arrow = wire(overlay.inputs[0].message, shape);
  const icon = wire(overlay.icons, shape);
  const search = Object.fromEntries(
    overlay.inputs
      .filter(({ input }) => input.kind === 'query')
      .map(({ id, message }) => [id, { bytes: wire(message, shape).bytes, rows: message.frame.results.length }]),
  );
  const jobs = operations(work, start, arrow, icon, shape);
  return {
    work,
    overlay,
    jobs,
    messages: { start: start.bytes, move: arrow.bytes, icons: icon.bytes, search },
    icons: { reads, globeReads, peakInFlight },
  };
}

export async function coreTrial({ work, jobs }, signal) {
  signal.throwIfAborted();
  const loadBefore = load();
  const ms = {};
  for (const job of jobs) {
    if (job.async) {
      const delivery = await job.run();
      assert(delivery.icons.length === work.rows, 'Favicon dispatch dropped synthetic rows');
      ms[job.id] = delivery.ms;
    } else {
      const begin = performance.now();
      invoke(job);
      ms[job.id] = (performance.now() - begin) / job.batch;
    }
  }
  assert(value !== undefined, 'Missing core benchmark result');
  return { load: loadBefore, ms };
}

export async function measureCore(prepared, signal) {
  const {
    work: { rows, windows },
    jobs,
    messages,
    icons,
  } = prepared;
  const startLoad = load();
  const trials = [];
  for (let i = -CORE_WARMUP; i < CORE_RUNS; i++) {
    const trial = await coreTrial(prepared, signal);
    if (i >= 0) trials.push(trial);
  }
  return {
    rows,
    windows,
    load: { start: startLoad, end: load() },
    messages,
    icons,
    stages: summarize(jobs, trials),
    trials,
  };
}

function sourceFunction(frame) {
  if (!frame?.url.startsWith('file:')) return null;
  const source = path.relative(process.cwd(), fileURLToPath(frame.url));
  if (!source.startsWith('src/') && !source.startsWith('test/bench/scale/')) return null;
  return (frame.functionName || '(anonymous)') + ' (' + source + ')';
}

export async function profileCore(job, signal) {
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.setSamplingInterval', { interval: 100 });
    await inspector.post('Profiler.start');
    const stop = performance.now() + PROFILE_MS;
    do {
      signal.throwIfAborted();
      if (job.async) value = await job.run();
      else invoke(job);
    } while (performance.now() < stop);
    const { profile } = await inspector.post('Profiler.stop');
    let at = profile.startTime;
    const nodes = new Map(profile.nodes.map(({ id, callFrame }) => [id, callFrame]));
    const intervals = profile.samples.map((sample, i) => {
      const from = at;
      at += profile.timeDeltas[i];
      return { sample, from, to: at };
    });
    assert(intervals.length > 0, 'V8 returned no benchmark CPU samples');
    return hotFunctions([{ nodes, intervals }], { from: profile.startTime, to: at }, sourceFunction);
  } finally {
    inspector.disconnect();
  }
}
