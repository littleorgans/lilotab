import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RESULT_SCHEMA, compareStages, display, sampleStats } from '../results.mjs';

const precision = (ms) => Number(ms.toFixed(4));
const format = (ms) => ms.toFixed(3);
const frameBudget = 16;
const growthMargin = 1.2;
const growthFloor = 0.005;

export function summarize(stages, trials) {
  return Object.fromEntries(
    stages.map(({ id, label, diagnostic }) => [
      id,
      {
        label,
        ...(diagnostic ? { diagnostic } : {}),
        ...sampleStats(
          trials.map(({ ms }) => ms[id]),
          precision,
        ),
      },
    ]),
  );
}

export function findings(cases) {
  const overFrame = [];
  const fasterThanLinear = [];
  for (const [i, current] of cases.entries()) {
    const previous = cases[i - 1];
    for (const [id, { label, medianMs, p95Ms }] of Object.entries(current.stages)) {
      if (p95Ms > frameBudget) overFrame.push({ id, label, rows: current.rows, medianMs, p95Ms });
      if (previous) {
        const smallerMs = previous.stages[id].medianMs;
        const rowsRatio = current.rows / previous.rows;
        const timeRatio = medianMs / smallerMs;
        if (smallerMs >= growthFloor && timeRatio > rowsRatio * growthMargin)
          fasterThanLinear.push({
            id,
            label,
            from: previous.rows,
            rows: current.rows,
            timeRatio: precision(timeRatio),
            rowsRatio,
          });
      }
    }
  }
  return { overFrame, fasterThanLinear };
}

const columns = (cases) => cases.map(({ rows, windows }) => rows + ' / ' + windows);
const table = (left, sizes, cells) => [
  '| ' + [left, ...sizes].join(' | ') + ' |',
  '| --- | ' + sizes.map(() => '---:').join(' | ') + ' |',
  ...cells.map((row) => '| ' + row.join(' | ') + ' |'),
];
const stageTable = (cases) =>
  table(
    'Stage',
    columns(cases),
    Object.entries(cases[0].stages).map(([id, { label }]) => [
      label,
      ...cases.map(({ stages }) => format(stages[id].medianMs) + ' / ' + format(stages[id].p95Ms)),
    ]),
  );

function signalLines({ overFrame, fasterThanLinear }) {
  return [
    ...(overFrame.length
      ? overFrame.map(
          ({ label, rows, medianMs, p95Ms }) =>
            '- **Above 16 ms**. ' +
            label +
            ' at ' +
            rows +
            ' rows, ' +
            format(medianMs) +
            ' / ' +
            format(p95Ms) +
            ' ms.',
        )
      : ['- Every stage p95 was at or below 16 ms.']),
    ...(fasterThanLinear.length
      ? fasterThanLinear.map(
          ({ label, from, rows, timeRatio, rowsRatio }) =>
            '- **Faster than row growth**. ' +
            label +
            ' from ' +
            from +
            ' to ' +
            rows +
            ' rows, ' +
            display(timeRatio) +
            '× median time for ' +
            rowsRatio +
            '× rows.',
        )
      : ['- No median met the growth flag.']),
  ];
}

const functions = (top) => top.map(({ name, selfMs }) => '`' + name + '` ' + display(selfMs) + ' ms').join(', ');

export function summaryMarkdown(result) {
  const { core, browser, load } = result;
  const chromeProfiles = browser.flatMap(({ rows, trace, stages }) => {
    const observations = findings(browser);
    const ids = new Set(
      [...observations.overFrame, ...observations.fasterThanLinear]
        .filter((point) => point.rows === rows)
        .map(({ id }) => id),
    );
    return [...ids].map((id) => {
      const sample = trace.stages[id];
      const rendering = Object.entries(sample.render)
        .filter(([, { count }]) => count > 0)
        .map(([name, { ms }]) => name + ' ' + display(ms) + ' ms');
      return (
        '- ' +
        stages[id].label +
        ' at ' +
        rows +
        ' rows. ' +
        (functions(sample.top) || 'No JavaScript samples in this span') +
        (rendering.length ? '. Renderer events ' + rendering.join(', ') : '') +
        '.'
      );
    });
  });
  return [
    'Written by tm/generalist (GPT-6).',
    '',
    '# Lilotab synthetic scale benchmark',
    '',
    result.started +
      '. Source commit `' +
      result.commit +
      '`. ' +
      (result.dirty ? 'The source tree had changes. ' : '') +
      result.logicalCpus +
      ' logical CPUs. ' +
      'The 1, 5 and 15 minute load averages were ' +
      load.start.join(', ') +
      ' at entry and ' +
      load.end.join(', ') +
      ' at exit.',
    '',
    'Columns give synthetic rows / windows. Cells give median / p95 in ms. Node used ' +
      result.runs.node +
      ' samples after ' +
      result.warmup.node +
      ' warm ups. Chrome for Testing ' +
      result.chrome +
      ' used ' +
      result.runs.chrome +
      ' samples after ' +
      result.warmup.chrome +
      ' warm ups per size, in one headless tab.',
    '',
    '## Node',
    '',
    ...stageTable(core),
    '',
    ...table('Compact JSON, UTF-8 bytes', columns(core), [
      ['Start', ...core.map(({ messages }) => messages.start)],
      ['Arrow Down frame', ...core.map(({ messages }) => messages.move)],
      ...Object.keys(core[0].messages.search).map((id) => [
        core[0].stages[id].label.replace(' ranking', '') + ' frame',
        ...core.map(({ messages }) => messages.search[id].bytes),
      ]),
      ['Favicon patch', ...core.map(({ messages }) => messages.icons)],
      ['Favicon page reads', ...core.map(({ icons }) => icons.reads)],
      ['Favicon shared globe reads', ...core.map(({ icons }) => icons.globeReads)],
      ['Peak favicon reads in flight', ...core.map(({ icons }) => icons.peakInFlight)],
    ]),
    '',
    ...signalLines(findings(core)),
    '',
    '## Headless overlay',
    '',
    ...stageTable(browser),
    '',
    ...table(
      'List rows / shadow elements',
      columns(browser),
      Object.entries(browser[0].counts).map(([id]) => [
        browser[0].stages[id].label,
        ...browser.map(({ counts }) => counts[id].rows + ' / ' + counts[id].elements),
      ]),
    ),
    '',
    ...signalLines(findings(browser)),
    '',
    'The growth flag uses adjacent sizes, a starting median of at least 0.005 ms, and a time ratio over 1.2 times ' +
      'the row ratio. Window count scales with row count. These are workload measurements.',
    '',
    '## Sampled JavaScript self time',
    '',
    'Node profiles run separately for 250 ms per stage. Chrome uses a separate traced trial at each size. ' +
      'Renderer events report inclusive time. The frame proxy is a task posted from the animation callback after the DOM update.',
    '',
    ...core.flatMap(({ rows, stages, profiles }) =>
      Object.entries(profiles).map(
        ([id, top]) =>
          '- ' +
          stages[id].label +
          ' at ' +
          rows +
          ' rows. ' +
          (functions(top) || 'No attributed JavaScript samples') +
          '.',
      ),
    ),
    ...chromeProfiles,
    '',
    'The browser timings begin with synthetic, deserialized messages and include the real host and list view. ' +
      'The fixture bundles the overlay in timing mode with minification disabled for attribution. Service worker wake, ' +
      'tab enumeration, Chrome message transport, real favicon cache reads and physical display presentation are unverified.',
    '',
  ].join('\n');
}

export function compare(beforePath, afterPath) {
  const read = (file) => {
    assert(fs.existsSync(file), 'Scale result file missing');
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(result.schema === RESULT_SCHEMA && result.kind === 'scale', 'Expected a current scale benchmark result');
    return result;
  };
  const before = read(beforePath);
  const after = read(afterPath);
  return ['core', 'browser']
    .flatMap((section) => {
      assert(before[section].length === after[section].length, 'Compare results with matching scale cases');
      return before[section].map((old, i) => {
        const current = after[section][i];
        assert(
          old.rows === current.rows && old.windows === current.windows,
          'Compare results with matching scale cases',
        );
        const stages = Object.entries(old.stages).map(([id, stage]) => ({ id, ...stage }));
        return (
          section +
          ', ' +
          old.rows +
          ' rows / ' +
          old.windows +
          ' windows\n' +
          compareStages(stages, old.stages, current.stages, format)
        );
      });
    })
    .join('\n\n');
}
