import fs from 'node:fs';
import path from 'node:path';
import { fixtureServer } from '../chrome/fixtures.mjs';
import { fixtureTabs, runTrial } from './journey.mjs';
import { measurements, rounded } from './results.mjs';
import { closeFixtureServer, load, withBenchChrome } from './runtime.mjs';

export const BOOTS = ['cold', 'warm'];
export const COLD_PROFILE = 'fresh per cold and warm pair';

export async function withOverlayFixture(executable, directory, tabs, extension, signal, run) {
  const server = await fixtureServer();
  try {
    return await withBenchChrome(executable, directory, signal, async (browser, version) => {
      const fixture = await fixtureTabs(browser, server, tabs, extension);
      return await run(browser, fixture, version);
    });
  } finally {
    await closeFixtureServer(server);
  }
}

export async function overlayPair({ executable, directory, tabs, extension, signal }, makeTrace) {
  signal.throwIfAborted();
  using scratch = fs.mkdtempDisposableSync(path.join(directory, 'overlay-chrome-'));
  return await withOverlayFixture(
    executable,
    scratch.path,
    tabs,
    extension,
    signal,
    async (browser, fixture, chrome) => {
      const trials = [];
      const traces = [];
      for (const boot of BOOTS) {
        signal.throwIfAborted();
        const loadBefore = load();
        const trace = makeTrace?.(fixture.root, boot);
        const { marks, gateWaited } = await runTrial(browser, fixture, boot, trace, signal);
        if (trace) {
          traces.push({ ...trace.summary(), load: loadBefore });
        } else {
          const trial = { boot, load: loadBefore, gateWaited, ms: measurements(boot, marks) };
          if (boot === 'cold') {
            trial.workerStartup = {
              requestToOriginMs: rounded(marks.workerOrigin - marks.request),
              originToEntryMs: rounded(marks.entry - marks.workerOrigin),
            };
          }
          trials.push(trial);
        }
      }
      return { chrome, trials, traces };
    },
  );
}
