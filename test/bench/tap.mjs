import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { installChrome } from '../chrome/browser.mjs';
import { scrub, within } from '../chrome/support.mjs';
import { withOverlayFixture } from './overlay.mjs';
import { BENCH_CHROME_ARGS, benchSignal, build, command, load, utc, withBenchLock } from './runtime.mjs';
import { moveTapTarget, prepareTap, runTapTrial } from './tap-journey.mjs';

function options(args) {
  let tabs = 100;
  let padding = 400;
  let delays = [0, 30, 60, 120, 250];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = args.slice(i, i + 2);
    const values = (value ?? '').split(',');
    assert(
      values.every((item) => /^\d+$/.test(item)),
      'Tap options take whole numbers',
    );
    const numbers = values.map(Number);
    assert(numbers.every(Number.isSafeInteger), 'Tap option out of range');
    if (flag === '--delays') {
      assert(
        numbers.every((ms) => ms <= 1000),
        'Tap delays must be between 0 and 1000 ms',
      );
      delays = [...new Set(numbers)];
    } else if (numbers.length === 1 && flag === '--tabs') tabs = numbers[0];
    else if (numbers.length === 1 && flag === '--padding') padding = numbers[0];
    else throw new Error('Usage: just bench tap [--tabs N] [--padding N] [--delays MS,MS,...]');
  }
  assert(tabs >= 3 && tabs <= 100, 'Benchmark tab count must be between 3 and 100');
  assert(padding <= 3000, 'Synthetic row padding must be between 0 and 3000');
  return { tabs, padding, delays };
}

async function trials(rig, config, observe) {
  const paddingCases = config.padding === 0 ? [0] : [0, config.padding];
  for (const cross of [false, true]) {
    const windowId = cross ? await moveTapTarget(rig) : rig.source.windowId;
    const realTabs = await rig.worker.evaluate(async () => (await globalThis.chrome.tabs.query({})).length);
    assert.equal(realTabs, config.tabs, 'Window setup changed the real tab count');
    const layout = cross ? 'cross window' : 'same window';
    for (const discarded of [false, true]) {
      for (const padding of paddingCases) {
        const cases =
          cross || discarded
            ? []
            : [...config.delays.map((delayMs) => ({ release: 'timed', delayMs })), { release: 'before-listen' }];
        cases.push({ release: 'shown' });
        for (const release of cases) {
          await observe({ cross, windowId }, { layout, discarded, padding, ...release });
        }
      }
    }
  }
}

async function measure(config, scratch, signal, data, save) {
  const extension = path.join(scratch, 'extension');
  await build(
    './node_modules/.bin/vp',
    ['build', '--mode', 'timing', '--outDir', extension],
    path.join(scratch, 'build.log'),
    signal,
  );
  const executable = await installChrome({ cache: path.join(scratch, 'browsers') });
  signal.throwIfAborted();
  await withOverlayFixture(executable, scratch, config.tabs, extension, signal, async (_, fixture, version) => {
    data.chrome = version;
    const rig = await prepareTap(fixture);
    await trials(rig, config, async (where, trial) => {
      signal.throwIfAborted();
      data.current = { ...trial, load: load() };
      save();
      const measured = await within(24000, () => runTapTrial(rig, where, trial, signal), 'Tap trial');
      data.trials.push({ ...data.current, ...measured });
      data.current = null;
      save();
      console.log('Tap trial ' + data.trials.length + ' ended via ' + measured.worker.reason + '.');
    });
  });
}

export async function tap(args) {
  const config = options(args);
  const signal = benchSignal();
  await withBenchLock(signal, async (scratch) => {
    const now = new Date();
    const output = path.join('.bench', 'tap', now.toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const data = {
      schema: 1,
      commit: command('git', ['rev-parse', 'HEAD']),
      dirty: Boolean(command('git', ['status', '--porcelain'])),
      started: utc(now),
      logicalCpus: cpus().length,
      chromeArgs: BENCH_CHROME_ARGS,
      load: { start: load() },
      ...config,
      trials: [],
    };
    const save = () => {
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    };
    try {
      await measure(config, scratch, signal, data, save);
      data.chromeShutdownVerified = true;
      data.load.end = load();
      save();
      console.log('Tap results saved in ' + output + '. Chrome shutdown verified.');
    } catch (error) {
      signal.throwIfAborted();
      fs.writeFileSync(path.join(output, 'diagnostic.log'), scrub(error.stack ?? error), { mode: 0o600 });
      for (const name of ['build.log', 'browser.log']) {
        const source = path.join(scratch, name);
        if (fs.existsSync(source))
          fs.writeFileSync(path.join(output, name), scrub(fs.readFileSync(source, 'utf8')), { mode: 0o600 });
      }
      throw Object.assign(new Error('See tap benchmark diagnostics in ' + output + '.'), {
        exitCode: error.exitCode,
      });
    }
  });
}
