import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { BENCH_MARK } from '../../src/browser/timing.ts';
import { scrub, within } from '../chrome/support.mjs';
import { INPUT_FRAME_MARK, OPEN_FRAME_MARK, RENDER_TURN_MARK } from './journey.mjs';
import { rounded, spans } from './results.mjs';

const CATEGORIES = [
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'cc',
  'v8',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
];
const thread = (event) => event.pid + ':' + event.tid;

export function traceMarks(events, names = BENCH_MARK) {
  const relevant = Object.entries({
    ...names,
    firstFrame: OPEN_FRAME_MARK,
    inputFrame: INPUT_FRAME_MARK,
    renderTurn: RENDER_TURN_MARK,
  });
  const markers = Object.fromEntries(
    relevant.map(([name, label]) => [
      name,
      events
        .filter((event) => event.name === label && event.cat?.includes('blink.user_timing'))
        .sort((a, b) => a.ts - b.ts),
    ]),
  );
  const clock = (name) => markers[name][0]?.ts;
  const marks = Object.fromEntries(relevant.map(([name]) => [name, clock(name)]));
  marks.keys = markers.key.map((mark) => mark.ts);
  marks.frames = markers.frame.map((mark) => mark.ts);
  marks.frameProxies = markers.inputFrame.map((mark) => mark.ts);
  marks.renderTurns = markers.renderTurn.map((mark) => mark.ts);
  return { marks, worker: markers.entry[0], renderer: markers.startReceived[0] };
}

const RENDER_EVENTS = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'];
const finishedAt = (event) => event.ts + (event.dur ?? 0);

export function rendererActivity(events, renderer) {
  const local = events.filter((event) => thread(event) === thread(renderer) && RENDER_EVENTS.includes(event.name));
  const completed = (from, to) => local.filter((event) => event.ts >= from && finishedAt(event) <= to);
  function summarize(work) {
    return Object.fromEntries(
      RENDER_EVENTS.map((name) => {
        const matches = work.filter((event) => event.name === name);
        return [
          name,
          { count: matches.length, ms: rounded(matches.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000) },
        ];
      }),
    );
  }
  return {
    span: ({ from, to }) => summarize(completed(from, to)),
    frames(marks) {
      const updates = [marks.listEnd, ...marks.frames];
      const ends = [marks.firstFrame, ...marks.frameProxies];
      assert(
        updates.length === ends.length && ends.length === marks.renderTurns.length,
        'Unpaired render turns in trace',
      );
      return updates.map((from, i) => {
        const turn = marks.renderTurns[i];
        const to = ends[i];
        assert(from <= turn && turn <= to, 'Unordered DOM, render callback and frame markers');
        const work = completed(from, to);
        const paints = work.filter((event) => event.name === 'Paint' && event.ts >= turn);
        return {
          domToCallbackMs: rounded((turn - from) / 1000),
          callbackToFrameMs: rounded((to - turn) / 1000),
          lastPaintToFrameMs: paints.length ? rounded((to - Math.max(...paints.map(finishedAt))) / 1000) : null,
          render: summarize(work),
        };
      });
    },
  };
}

export function scriptsIn(events, threads) {
  const profiles = new Map();
  // Profile origin identifies the sampled thread. V8 emits its chunks on a separate sampling thread.
  const profileKey = (event) => event.pid + ':' + (event.id ?? event.id2?.local ?? event.id2?.global ?? '');
  for (const event of events) {
    if (event.name === 'Profile' && threads.has(thread(event)))
      profiles.set(profileKey(event), { at: event.args?.data?.startTime ?? event.ts, nodes: new Map(), intervals: [] });
  }
  for (const event of events) {
    if (event.name !== 'ProfileChunk') continue;
    const profile = profiles.get(profileKey(event));
    const data = event.args?.data;
    if (!profile || !data) continue;
    for (const node of data.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node.callFrame);
    for (const [i, sample] of (data.cpuProfile?.samples ?? []).entries()) {
      const from = profile.at;
      profile.at += data.timeDeltas?.[i] ?? 0;
      profile.intervals.push({ from, to: profile.at, sample });
    }
  }
  return [...profiles.values()];
}

function frameName(frame) {
  if (!frame || /^(\(idle\)|\(program\)|\(garbage collector\)|\(root\))$/.test(frame.functionName)) return null;
  const name = scrub(frame.functionName || '(anonymous)');
  if (!frame.url?.startsWith('chrome-extension:')) return name;
  const asset = path.resolve('dist-timing', '.' + new URL(frame.url).pathname);
  if (!asset.startsWith(path.resolve('dist-timing') + path.sep)) return name;
  if (!maps.has(asset)) {
    const file = asset + '.map';
    maps.set(asset, fs.existsSync(file) ? new SourceMap(JSON.parse(fs.readFileSync(file, 'utf8'))) : null);
  }
  const original =
    Number.isInteger(frame.lineNumber) && Number.isInteger(frame.columnNumber)
      ? maps.get(asset)?.findEntry(frame.lineNumber, frame.columnNumber)
      : null;
  const source = original?.originalSource?.replace(/^(?:\.\.\/)+/, '');
  return source?.startsWith('src/') ? (original.name || name) + ' (' + source + ')' : name;
}
const maps = new Map();

export function hotFunctions(profiles, span, nameOf = frameName) {
  const totals = new Map();
  for (const { nodes, intervals } of profiles) {
    for (const { from, to, sample } of intervals) {
      const overlap = Math.min(to, span.to) - Math.max(from, span.from);
      if (overlap <= 0) continue;
      const name = nameOf(nodes.get(sample));
      if (name) totals.set(name, (totals.get(name) ?? 0) + overlap);
    }
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, us]) => ({ name, selfMs: rounded(us / 1000) }));
}

function analyze(events, boot, file) {
  const { marks, worker, renderer } = traceMarks(events);
  assert(worker && renderer, 'Trace lacks the extension worker or overlay marks');
  const profiles = scriptsIn(events, new Set([thread(worker), thread(renderer)]));
  const activity = rendererActivity(events, renderer);
  assert(
    profiles.some((profile) => profile.intervals.length),
    'Trace lacks JavaScript CPU samples on the measured threads',
  );
  const stages = Object.fromEntries(
    spans(boot, marks).map((span) => [
      span.id,
      {
        ms: rounded((span.to - span.from) / 1000),
        top: hotFunctions(profiles, span),
      },
    ]),
  );
  const paints = events
    .filter(
      (event) =>
        thread(event) === thread(renderer) &&
        event.name === 'Paint' &&
        event.ts >= marks.listEnd &&
        finishedAt(event) <= marks.firstFrame,
    )
    .sort((a, b) => a.ts - b.ts);
  return {
    boot,
    file,
    rendererPaints: paints.length,
    firstRendererPaintMs: paints.length ? rounded((paints[0].ts - marks.startReceived) / 1000) : null,
    frames: activity.frames(marks),
    stages,
  };
}

export function captureTrace(root, directory, file) {
  return {
    async start() {
      await root.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        traceConfig: { includedCategories: CATEGORIES },
      });
    },
    async stop() {
      const { stream } = await within(
        10000,
        async () => {
          const complete = new Promise((resolve) => root.once('Tracing.tracingComplete', resolve));
          await root.send('Tracing.end');
          return await complete;
        },
        'Stop CDP trace',
      );
      assert(stream, 'Chrome did not return a trace stream');
      const chunks = [];
      try {
        let chunk;
        do {
          chunk = await root.send('IO.read', { handle: stream });
          chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
        } while (!chunk.eof);
      } finally {
        await root.send('IO.close', { handle: stream });
      }
      const raw = Buffer.concat(chunks);
      fs.writeFileSync(path.join(directory, file), raw, { flag: 'wx', mode: 0o600 });
      return JSON.parse(raw.toString('utf8')).traceEvents;
    },
  };
}

export function traceRun(root, directory, boot) {
  const file = boot + '.trace.json';
  const capture = captureTrace(root, directory, file);
  let summary;
  return {
    start: capture.start,
    async stop() {
      summary = analyze(await capture.stop(), boot, file);
    },
    summary: () => summary,
  };
}
