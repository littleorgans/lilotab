import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SEARCH_KEYS, MOVES } from './journey.mjs';

export const RESULT_SCHEMA = 3;
const stage = (id, label, start, end, boot) => ({ id, label, start, end, boot });
export const inputStages = (id, label, i) => [
  stage(id + 'Frame', label + ' to frame', ['keys', i], ['frameProxies', i]),
  { ...stage(id, label + ' to DOM', ['keys', i], ['frames', i]), diagnostic: true },
];
export const STAGES = [
  stage('wakeCold', 'Service worker wake (cold)', 'request', 'entry', 'cold'),
  stage('wakeWarm', 'Service worker dispatch (warm)', 'request', 'entry', 'warm'),
  stage('tabQuery', 'Tab query', 'queryStart', 'queryEnd'),
  stage('prepareOverlay', 'Query complete to overlay start send', 'queryEnd', 'startSent'),
  stage('hostMessage', 'Worker message to content script', 'startSent', 'startReceived'),
  stage('listRender', 'Initial list render', 'listStart', 'listEnd'),
  stage('firstPaint', 'Overlay receive to first frame proxy', 'startReceived', 'firstFrame'),
  stage('openCold', 'Open to first frame proxy (cold)', 'request', 'firstFrame', 'cold'),
  stage('openWarm', 'Open to first frame proxy (warm)', 'request', 'firstFrame', 'warm'),
  ...SEARCH_KEYS.flatMap((key, i) => inputStages('search' + (i + 1), 'Search key ' + key.toUpperCase(), i)),
  ...Array.from({ length: MOVES }, (_, i) =>
    inputStages('move' + (i + 1), 'Selection move ' + (i + 1), SEARCH_KEYS.length + i),
  ).flat(),
  stage('switch', 'Enter to tab activation', ['keys', SEARCH_KEYS.length + MOVES], 'activated'),
];

export function stageSpans(stages, marks) {
  const read = (ref) => (typeof ref === 'string' ? marks[ref] : marks[ref[0]]?.[ref[1]]);
  return stages.map(({ id, start, end }) => {
    const from = read(start),
      to = read(end);
    assert(Number.isFinite(from) && Number.isFinite(to) && to >= from, 'Missing or unordered timing markers for ' + id);
    return { id, from, to };
  });
}

export const spans = (boot, marks) =>
  stageSpans(
    STAGES.filter((item) => !item.boot || item.boot === boot),
    marks,
  );

export const rounded = (ms) => Number(ms.toFixed(2));
export const display = (ms) => ms.toFixed(2);
export const measurements = (boot, marks) =>
  Object.fromEntries(spans(boot, marks).map(({ id, from, to }) => [id, rounded(to - from)]));

export function sampleStats(samples, round = rounded) {
  const values = samples.toSorted((a, b) => a - b);
  const count = values.length;
  assert(count > 0, 'Expected benchmark samples');
  const median = (values[Math.floor((count - 1) / 2)] + values[Math.floor(count / 2)]) / 2;
  return { count, medianMs: round(median), p95Ms: round(values[Math.ceil(count * 0.95) - 1]) };
}

export function summarize(trials) {
  return Object.fromEntries(
    STAGES.map(({ id }) => {
      const values = trials.flatMap((trial) => (Object.hasOwn(trial.ms, id) ? [trial.ms[id]] : []));
      return [id, sampleStats(values)];
    }),
  );
}

export function summaryMarkdown(result) {
  const open = result.load.start.join(', ');
  const close = result.load.end.join(', ');
  const stages = STAGES.map(({ id, label }) => {
    const stats = result.stages[id];
    return '| ' + [label, stats.count, display(stats.medianMs), display(stats.p95Ms)].join(' | ') + ' |';
  });
  const slowest = STAGES.toSorted((a, b) => result.stages[b.id].medianMs - result.stages[a.id].medianMs).slice(0, 5);
  const hotspots = slowest.map(({ id, label }) => {
    const perBoot = result.traces
      .filter((trace) => trace.stages[id])
      .map((trace) => {
        const functions = trace.stages[id].top.map(({ name, selfMs }) => name + ' (' + display(selfMs) + ' ms)');
        return trace.boot + ' ' + (functions.join(', ') || 'had no attributed JavaScript samples');
      });
    return '- **' + label + '**. ' + perBoot.join('. ') + '.';
  });
  const paints = result.traces.map(({ boot, rendererPaints, firstRendererPaintMs }) =>
    firstRendererPaintMs === null
      ? 'the ' + boot + ' trace had zero renderer Paint events within the bracket'
      : 'the ' +
        boot +
        ' trace had ' +
        rendererPaints +
        ' renderer Paint events, first at ' +
        display(firstRendererPaintMs) +
        ' ms from start receipt',
  );
  return [
    'Written by tm/generalist (GPT-6).',
    '',
    '# Lilotab headless benchmark',
    '',
    result.started +
      '. ' +
      result.tabs +
      ' local tabs in one window, ' +
      result.runsPerBoot +
      ' trials per worker condition, a fresh profile per cold and warm pair, Chrome for Testing ' +
      result.chrome +
      '.',
    '',
    'Measured commit `' +
      result.commit +
      '`. ' +
      (result.dirty ? 'Tracked working tree had changes. ' : '') +
      result.logicalCpus +
      ' logical CPUs. The 1, 5 and 15 minute load averages were ' +
      open +
      ' at entry and ' +
      close +
      ' at exit.',
    '',
    '| Stage | Samples | Median (ms) | p95 (ms) |',
    '| --- | ---: | ---: | ---: |',
    ...stages,
    '',
    '## CDP trace hot spots',
    '',
    'The five stages with the largest medians, using sampled JavaScript self time from one separate trace per worker condition. Stages overlap.',
    '',
    ...hotspots,
    '',
    'Between the list render and the frame proxy, ' + paints.join(', and ') + '.',
    '',
    'The overlay frame proxy is a task posted from the animation callback after the DOM update. It follows work on the headless renderer thread. The run measures Chrome tab activation and trusted in page key dispatch. Native shortcut delivery, display presentation and OS focus are unmeasured.',
    '',
  ].join('\n');
}

export function compare(beforePath, afterPath) {
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = read(beforePath),
    after = read(afterPath);
  assert(
    before.schema === RESULT_SCHEMA && after.schema === RESULT_SCHEMA && before.tabs === after.tabs,
    'Compare current benchmark results with the same tab count',
  );
  return compareStages(STAGES, before.stages, after.stages);
}

export function compareStages(stages, before, after, format = display) {
  const signed = (ms) => (ms > 0 ? '+' : '') + format(ms);
  const lines = ['Stage | Before median → after (Δ ms) | Before p95 → after (Δ ms)'];
  for (const { id, label } of stages.filter(({ diagnostic }) => !diagnostic)) {
    const old = before[id],
      current = after[id];
    assert(
      [old?.medianMs, current?.medianMs, old?.p95Ms, current?.p95Ms].every(Number.isFinite),
      'Missing stage ' + id,
    );
    const pair = (field) =>
      format(old[field]) + ' → ' + format(current[field]) + ' (' + signed(current[field] - old[field]) + ')';
    lines.push([label, pair('medianMs'), pair('p95Ms')].join(' | '));
  }
  return lines.join('\n');
}
