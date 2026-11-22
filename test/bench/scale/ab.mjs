import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SIDES, benchmarkAB, interleave } from '../ab.mjs';
import { chromeExecutable } from '../runtime.mjs';
import {
  CHROME_RUNS,
  CHROME_STAGES,
  CHROME_WARMUP,
  buildScaleFixture,
  traceScaleTrial,
  withScaleChrome,
} from './browser.mjs';
import { CORE_RUNS, CORE_WARMUP } from './core.mjs';
import { SIZES } from './workload.mjs';

const PROBE_FILES = [
  'journey.mjs',
  'results.mjs',
  'runtime.mjs',
  'trace.mjs',
  'scale/core.mjs',
  'scale/report.mjs',
  'scale/vite.config.mjs',
  'scale/workload.mjs',
];

async function prepareArm(directory, log, signal) {
  const probes = fileURLToPath(new URL('../', import.meta.url));
  const target = path.join(directory, 'test', 'bench');
  fs.mkdirSync(path.join(target, 'scale'), { recursive: true, mode: 0o700 });
  // Run the same Node probe from each tree so its imports resolve that ref's product modules.
  for (const file of PROBE_FILES) fs.copyFileSync(path.join(probes, file), path.join(target, file));
  const bundle = await buildScaleFixture(path.join(directory, 'scale-timing'), log, signal, directory);
  const { prepareCase, coreTrial } = await import(pathToFileURL(path.join(target, 'scale', 'core.mjs')).href);
  return { bundle, prepareCase, coreTrial };
}

const sizeLabel = ({ rows, windows }) => rows + ' rows / ' + windows + ' windows';

async function measure(arms, scratch, signal, output) {
  const sections = [];
  const workloads = [];
  for (const size of SIZES) {
    const cases = {};
    for (const side of SIDES) cases[side] = await arms[side].prepareCase(size);
    const blocks = await interleave(CORE_RUNS, CORE_WARMUP, signal, async (side) => [
      await arms[side].coreTrial(cases[side], signal),
    ]);
    const stages = cases.base.jobs.map(({ id, label }) => ({ id, label }));
    sections.push({ label: 'Node, ' + sizeLabel(size), stages, blocks, digits: 3 });
    workloads.push({ size, cases });
    console.log('Interleaved Node trials at ' + size.rows + ' synthetic rows.');
  }

  const executable = await chromeExecutable();
  const withArm = (side, run) => {
    const directory = path.join(scratch, side + '-chrome');
    fs.mkdirSync(directory, { mode: 0o700 });
    return withScaleChrome(executable, arms[side].bundle, directory, signal, run);
  };
  const chrome = await withArm('base', (base) =>
    withArm('candidate', async (candidate) => {
      assert.equal(base.version, candidate.version, 'Chrome changed during scale A/B');
      const browsers = { base, candidate };
      for (const { size, cases } of workloads.slice(0, 2)) {
        for (const side of SIDES) await browsers[side].configure(cases[side].overlay);
        const counts = {};
        const blocks = await interleave(CHROME_RUNS, CHROME_WARMUP, signal, async (side) => {
          const { counts: observed, ...sample } = await browsers[side].trial();
          counts[side] ??= observed;
          assert.deepEqual(observed, counts[side], 'Overlay element counts varied between scale A/B trials');
          return [sample];
        });
        const traces = {};
        for (const side of SIDES)
          traces[side] = await traceScaleTrial(browsers[side], output, side + '-' + size.rows + '.trace.json');
        sections.push({ label: 'Chrome, ' + sizeLabel(size), stages: CHROME_STAGES, blocks, digits: 2, traces });
        console.log('Interleaved headless overlays at ' + size.rows + ' synthetic rows.');
      }
      return base.version;
    }),
  );
  return { chrome, realTabsPerArm: 1, chromeShutdownVerified: true, sections };
}

export async function scaleAB(refs) {
  await benchmarkAB('scale', refs, prepareArm, measure);
}
