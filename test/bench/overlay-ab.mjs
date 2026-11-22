import assert from 'node:assert/strict';
import path from 'node:path';
import { benchmarkAB, interleave } from './ab.mjs';
import { COLD_PROFILE, overlayPair } from './overlay.mjs';
import { STAGES } from './results.mjs';
import { build, chromeExecutable } from './runtime.mjs';

export async function overlayAB(refs, { tabs, runs }) {
  assert(runs >= 2, 'A/B needs at least two blocks');
  await benchmarkAB(
    'overlay',
    refs,
    async (directory, log, signal) => {
      await build('just', ['build-timing'], log, signal, directory);
      return path.join(directory, 'dist-timing');
    },
    async (arms, scratch, signal) => {
      const executable = await chromeExecutable();
      let chrome;
      let completed = 0;
      const blocks = await interleave(runs, 0, signal, async (side) => {
        const pair = await overlayPair({
          executable,
          directory: scratch,
          tabs,
          extension: arms[side],
          signal,
        });
        chrome ??= pair.chrome;
        assert.equal(pair.chrome, chrome, 'Chrome changed during A/B');
        completed++;
        if (completed % 10 === 0 || completed === runs * 2)
          console.log('Completed ' + completed + ' of ' + runs * 2 + ' A/B cold and warm pairs.');
        return pair.trials;
      });
      return {
        chrome,
        coldProfile: COLD_PROFILE,
        realTabs: tabs,
        chromeShutdownVerified: true,
        sections: [{ label: tabs + ' tabs in Chrome', stages: STAGES, blocks, digits: 2 }],
      };
    },
  );
}
