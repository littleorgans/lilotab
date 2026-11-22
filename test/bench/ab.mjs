import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { scrub } from '../chrome/support.mjs';
import { summarizeAB, summaryMarkdown } from './ab-report.mjs';
import { RESULT_SCHEMA } from './results.mjs';
import { BENCH_CHROME_ARGS, benchSignal, build, command, load, utc, withBenchLock } from './runtime.mjs';

export const SIDES = ['base', 'candidate'];

export async function interleave(runs, warmup, signal, trial) {
  const blocks = [];
  for (let i = -warmup; i < runs; i++) {
    const order = randomInt(2) === 0 ? SIDES : SIDES.toReversed();
    const block = { order };
    for (const side of order) {
      signal.throwIfAborted();
      block[side] = await trial(side);
    }
    if (i >= 0) blocks.push(block);
  }
  return blocks;
}

async function checkout(side, commit, scratch, signal) {
  const directory = path.join(scratch, side);
  const archive = path.join(scratch, side + '.tar');
  const log = (step) => path.join(scratch, side + '-' + step + '.log');
  fs.mkdirSync(directory, { mode: 0o700 });
  await build('git', ['archive', '--format=tar', '-o', archive, commit], log('archive'), signal);
  await build('tar', ['-xf', archive, '-C', directory], log('extract'), signal);
  await build('just', ['install'], log('install'), signal, directory);
  return directory;
}

export async function benchmarkAB(kind, refs, prepare, measure) {
  const signal = benchSignal();
  await withBenchLock(signal, async (scratch) => {
    const commits = refs.map((ref) => command('git', ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']));
    const now = new Date();
    const output = path.join('.bench', kind === 'scale' ? 'scale-ab' : 'ab', now.toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    try {
      const arms = {};
      for (const [i, side] of SIDES.entries()) {
        const directory = await checkout(side, commits[i], scratch, signal);
        arms[side] = await prepare(directory, path.join(scratch, side + '-build.log'), signal);
        console.log('Built ' + side + ' ' + commits[i].slice(0, 12) + ' in its isolated tree.');
      }
      const start = load();
      const { sections, ...metadata } = await measure(arms, scratch, signal, output);
      const result = {
        schema: RESULT_SCHEMA,
        kind: kind + '-ab',
        started: utc(now),
        commits: Object.fromEntries(SIDES.map((side, i) => [side, commits[i]])),
        logicalCpus: cpus().length,
        chromeArgs: BENCH_CHROME_ARGS,
        load: { start, end: load() },
        ...metadata,
        sections: sections.map(summarizeAB),
      };
      const summary = summaryMarkdown(result);
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fs.writeFileSync(path.join(output, 'summary.md'), summary, { flag: 'wx', mode: 0o600 });
      console.log(summary);
      console.log('A/B results saved in ' + output + '. Chrome shutdown verified.');
    } catch (error) {
      signal.throwIfAborted();
      fs.writeFileSync(path.join(output, 'diagnostic.log'), scrub(error.stack ?? error), { flag: 'wx', mode: 0o600 });
      for (const name of fs.readdirSync(scratch).filter((name) => name.endsWith('.log'))) {
        fs.copyFileSync(path.join(scratch, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
      }
      throw Object.assign(new Error('See A/B benchmark diagnostics in ' + output + '.'), { exitCode: error.exitCode });
    }
  });
}
