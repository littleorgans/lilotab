import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { scrub } from '../chrome/support.mjs';
import { COLD_PROFILE, overlayPair } from './overlay.mjs';
import { RESULT_SCHEMA, compare, summarize, summaryMarkdown } from './results.mjs';
import { traceRun } from './trace.mjs';
import {
  BENCH_CHROME_ARGS,
  benchSignal,
  build,
  chromeExecutable,
  command,
  load,
  utc,
  withBenchLock,
} from './runtime.mjs';

function options(args) {
  let tabs = 100,
    runs = 20;
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = args.slice(i, i + 2);
    const count = Number(value);
    assert(/^\d+$/.test(value ?? '') && Number.isSafeInteger(count), 'Expected a whole number for --tabs or --runs');
    if (flag === '--tabs') tabs = count;
    else if (flag === '--runs') runs = count;
    else throw new Error('Usage: just bench [--tabs N] [--runs N]');
  }
  assert(tabs >= 3 && tabs <= 100, 'Benchmark tab count must be between 3 and 100');
  assert(runs >= 1, 'At least one sample per worker condition is required');
  return { tabs, runs };
}

async function measure({ tabs, runs }, output, directory, signal) {
  const start = load();
  const executable = await chromeExecutable();
  const trials = [];
  const config = { executable, directory, tabs, extension: path.resolve('dist-timing'), signal };
  for (let i = 0; i < runs; i++) {
    trials.push(...(await overlayPair(config)).trials);
    if ((i + 1) % 5 === 0 || i + 1 === runs)
      console.log('Completed ' + (i + 1) + ' of ' + runs + ' cold and warm pairs.');
  }
  const { chrome, traces } = await overlayPair(config, (root, boot) => traceRun(root, output, boot));
  return {
    chrome,
    coldProfile: COLD_PROFILE,
    load: { start, end: load() },
    trials,
    traces,
    stages: summarize(trials),
    chromeShutdownVerified: true,
  };
}

async function bench(config) {
  const signal = benchSignal();
  await withBenchLock(signal, async (scratch) => {
    const now = new Date();
    const commit = command('git', ['rev-parse', 'HEAD']);
    const dirty = Boolean(command('git', ['status', '--porcelain', '--untracked-files=no']));
    const output = path.join('.bench', 'runs', now.toISOString().replace(/[:.]/g, '-'));
    await build('just', ['build-timing'], path.join(scratch, 'build.log'), signal);
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    let data;
    try {
      data = await measure(config, output, scratch, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    const result = {
      schema: RESULT_SCHEMA,
      commit,
      dirty,
      started: utc(now),
      tabs: config.tabs,
      runsPerBoot: config.runs,
      logicalCpus: cpus().length,
      chromeArgs: BENCH_CHROME_ARGS,
      ...data,
    };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'summary.md'), summaryMarkdown(result), { flag: 'wx' });
    console.log('Results and traces saved in ' + output + '. Chrome shutdown verified.');
  });
}

try {
  const args = process.argv.slice(2);
  if (args[0] === 'scale') {
    const { scale } = await import('./scale/run.mjs');
    await scale(args.slice(1));
  } else if (args[0] === 'tap') {
    const { tap } = await import('./tap.mjs');
    await tap(args.slice(1));
  } else if (args[0] === 'compare') {
    assert(args.length === 3, 'Usage: just bench compare BEFORE AFTER');
    console.log(compare(args[1], args[2]));
  } else if (args[0] === 'ab') {
    assert(args.length >= 3, 'Usage: just bench ab BASE CANDIDATE [--tabs N] [--runs N]');
    const { overlayAB } = await import('./overlay-ab.mjs');
    await overlayAB(args.slice(1, 3), options(args.slice(3)));
  } else {
    await bench(options(args));
  }
} catch (error) {
  const detail = scrub(error.message);
  console.error(
    'Benchmark failed. ' + (process.env.TMPDIR ? detail.replaceAll(process.env.TMPDIR, '[temp]/') : detail),
  );
  process.exitCode = error.exitCode ?? 1;
}
