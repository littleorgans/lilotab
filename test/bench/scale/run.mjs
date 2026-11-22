import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { RESULT_SCHEMA } from '../results.mjs';
import { BENCH_CHROME_ARGS, benchSignal, command, load, utc, withBenchLock } from '../runtime.mjs';
import { CHROME_RUNS, CHROME_WARMUP, buildScaleFixture, measureChrome } from './browser.mjs';
import { CORE_RUNS, CORE_WARMUP, measureCore, prepareCase, profileCore } from './core.mjs';
import { compare, findings, summaryMarkdown } from './report.mjs';
import { SIZES } from './workload.mjs';

async function addProfiles(cases, signal) {
  const results = cases.map(({ result }) => result);
  const { overFrame, fasterThanLinear } = findings(results);
  for (const [i, { jobs, result }] of cases.entries()) {
    const ids = new Set(
      [...overFrame, ...fasterThanLinear].filter(({ rows }) => rows === result.rows).map(({ id }) => id),
    );
    if (i === cases.length - 1) {
      const slowest = Object.entries(result.stages)
        .sort((a, b) => b[1].medianMs - a[1].medianMs)
        .slice(0, 3);
      for (const [id] of slowest) ids.add(id);
    }
    result.profiles = {};
    for (const job of jobs) if (ids.has(job.id)) result.profiles[job.id] = await profileCore(job, signal);
  }
}

async function measure(scratch, output, signal) {
  const bundle = await buildScaleFixture(path.join(scratch, 'fixture'), path.join(scratch, 'build.log'), signal);
  const cases = [];
  for (const size of SIZES) {
    const prepared = await prepareCase(size);
    const result = await measureCore(prepared, signal);
    cases.push({ ...prepared, result });
    console.log('Node pipeline measured at ' + size.rows + ' synthetic rows.');
  }
  const browser = await measureChrome(cases.slice(0, 2), bundle, output, scratch, signal);
  await addProfiles(cases, signal);
  return { core: cases.map(({ result }) => result), ...browser };
}

export async function scale(args) {
  if (args[0] === 'ab') {
    assert(args.length === 3, 'Usage: just bench scale ab BASE CANDIDATE');
    const { scaleAB } = await import('./ab.mjs');
    await scaleAB(args.slice(1));
    return;
  }
  if (args[0] === 'compare') {
    assert(args.length === 3, 'Usage: just bench scale compare BEFORE AFTER');
    console.log(compare(args[1], args[2]));
    return;
  }
  assert(args.length === 0, 'Usage: just bench scale [ab BASE CANDIDATE | compare BEFORE AFTER]');
  const signal = benchSignal();
  await withBenchLock(signal, async (scratch) => {
    const now = new Date();
    const output = path.join('.bench', 'scale', now.toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    try {
      const commit = command('git', ['rev-parse', 'HEAD']);
      const dirty = Boolean(command('git', ['status', '--porcelain', '--untracked-files=no']));
      const start = load();
      const data = await measure(scratch, output, signal);
      const result = {
        schema: RESULT_SCHEMA,
        kind: 'scale',
        commit,
        dirty,
        started: utc(now),
        logicalCpus: cpus().length,
        chromeArgs: BENCH_CHROME_ARGS,
        runs: { node: CORE_RUNS, chrome: CHROME_RUNS },
        warmup: { node: CORE_WARMUP, chrome: CHROME_WARMUP },
        load: { start, end: load() },
        ...data,
      };
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fs.writeFileSync(path.join(output, 'summary.md'), summaryMarkdown(result), { flag: 'wx', mode: 0o600 });
      console.log('Scale results and traces saved in ' + output + '. Chrome shutdown verified.');
    } catch (error) {
      signal.throwIfAborted();
      fs.writeFileSync(path.join(output, 'diagnostic.log'), String(error.stack ?? error), {
        flag: 'wx',
        mode: 0o600,
      });
      for (const name of ['build.log', 'browser.log']) {
        const log = path.join(scratch, name);
        if (fs.existsSync(log)) fs.copyFileSync(log, path.join(output, name), fs.constants.COPYFILE_EXCL);
      }
      throw Object.assign(new Error('See scale benchmark diagnostics in ' + output + '.'), {
        exitCode: error.exitCode,
      });
    }
  });
}
