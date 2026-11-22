import { sampleStats } from './results.mjs';

const RESAMPLES = 2000;
const unrounded = (value) => value;

function resamples(count) {
  // Seeded so the same recorded blocks give the same percentile intervals.
  let state = 42;
  return Array.from({ length: RESAMPLES }, () =>
    Array.from({ length: count }, () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return Math.floor((state / 2 ** 32) * count);
    }),
  );
}

function interval(deltaMs, draws) {
  const values = draws.toSorted((a, b) => a - b);
  return {
    deltaMs,
    lowMs: values[Math.ceil(values.length * 0.025) - 1],
    highMs: values[Math.ceil(values.length * 0.975) - 1],
  };
}

function comparison(blocks, id, draws) {
  const samples = (arm) => arm.flatMap(({ ms }) => (Object.hasOwn(ms, id) ? [ms[id]] : []));
  const before = blocks.map(({ base }) => samples(base));
  const after = blocks.map(({ candidate }) => samples(candidate));
  const estimate = (values) => sampleStats(values.flat(), unrounded);
  const base = estimate(before);
  const candidate = estimate(after);
  const deltas = draws.map((indices) => {
    const a = estimate(indices.map((i) => before[i]));
    const b = estimate(indices.map((i) => after[i]));
    return { median: b.medianMs - a.medianMs, p95: b.p95Ms - a.p95Ms };
  });
  return {
    base,
    candidate,
    median: interval(
      candidate.medianMs - base.medianMs,
      deltas.map(({ median }) => median),
    ),
    p95: interval(
      candidate.p95Ms - base.p95Ms,
      deltas.map(({ p95 }) => p95),
    ),
  };
}

function meanLoad(trials) {
  return [0, 1, 2].map((i) => trials.reduce((sum, trial) => sum + trial.load[i], 0) / trials.length);
}

export function summarizeAB({ label, stages, blocks, digits, traces }) {
  const draws = resamples(blocks.length);
  return {
    label,
    digits,
    blocks,
    ...(traces ? { traces } : {}),
    load: {
      base: meanLoad(blocks.flatMap(({ base }) => base)),
      candidate: meanLoad(blocks.flatMap(({ candidate }) => candidate)),
    },
    stages: stages.map(({ id, label, diagnostic }) => ({ id, label, diagnostic, ...comparison(blocks, id, draws) })),
  };
}

function keepFlags({ base, median, p95, diagnostic }) {
  if (diagnostic) return 'Diagnostic';
  const flags = [];
  if (median.highMs < 0 && -median.deltaMs >= Math.max(0.3, base.medianMs * 0.05)) flags.push('Target gain');
  if (median.deltaMs > Math.max(0.5, base.medianMs * 0.1)) flags.push('Median regression');
  if (p95.deltaMs > Math.max(0.5, base.p95Ms * 0.1)) flags.push('p95 regression');
  return flags.join(', ');
}

export function summaryMarkdown(result) {
  const loadText = (values) => values.map((value) => value.toFixed(2)).join(', ');
  return [
    'Written by tm/generalist (GPT-6).',
    '',
    '# Lilotab interleaved benchmark',
    '',
    result.started + '. Base `' + result.commits.base + '`, candidate `' + result.commits.candidate + '`.',
    '',
    result.logicalCpus +
      ' logical CPUs, Chrome for Testing ' +
      result.chrome +
      '. The 1, 5 and 15 minute loads were ' +
      loadText(result.load.start) +
      ' before measurement and ' +
      loadText(result.load.end) +
      ' after measurement.',
    '',
    'All timings are in ms. Δ is candidate minus base. Brackets show the 95% paired bootstrap interval from ' +
      RESAMPLES +
      ' resamples of whole blocks. An interval containing zero leaves the direction unresolved.',
    '',
    ...result.sections.flatMap(({ label, stages, blocks, load, digits }) => {
      const format = (value) => value.toFixed(digits);
      const stats = ({ medianMs, p95Ms }) => format(medianMs) + ' / ' + format(p95Ms);
      const signed = (value) => (value > 0 ? '+' : '') + format(value);
      const delta = ({ deltaMs, lowMs, highMs }) =>
        signed(deltaMs) + ' [' + signed(lowMs) + ', ' + signed(highMs) + ']';
      return [
        '## ' + label,
        '',
        blocks.length +
          ' blocks. Mean trial loads were ' +
          loadText(load.base) +
          ' for base and ' +
          loadText(load.candidate) +
          ' for candidate.',
        '',
        '| Stage | Base median / p95 | Candidate median / p95 | Median Δ [95% interval] | p95 Δ [95% interval] | Keep rule |',
        '| --- | ---: | ---: | ---: | ---: | --- |',
        ...stages.map(
          (stage) =>
            '| ' +
            [
              stage.label,
              stats(stage.base),
              stats(stage.candidate),
              delta(stage.median),
              delta(stage.p95),
              keepFlags(stage),
            ].join(' | ') +
            ' |',
        ),
        '',
      ];
    }),
  ].join('\n');
}
