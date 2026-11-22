import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_ARMED, BENCH_MARK } from '../../../src/browser/timing.ts';
import { within } from '../../chrome/support.mjs';
import { FRAME_BOUNDARIES, RENDER_TURN_MARK, armPage, pressKey, readOpenMarks, waitForMark } from '../journey.mjs';
import { inputStages, rounded, stageSpans } from '../results.mjs';
import { build, chromeExecutable, load, withBenchChrome } from '../runtime.mjs';
import { captureTrace, hotFunctions, rendererActivity, scriptsIn, traceMarks } from '../trace.mjs';
import { summarize } from './report.mjs';
import { installFixture } from './page.mjs';
import { MOVES_STAGES, SEARCH_STAGES } from './workload.mjs';

export const CHROME_WARMUP = 5;
export const CHROME_RUNS = 30;

const ICON_START = 'lilotab:scale-icon-start';
const ICON_END = 'lilotab:scale-icon-end';
const inputs = [...MOVES_STAGES, ...SEARCH_STAGES];
export const CHROME_STAGES = [
  { id: 'mount', label: 'Initial overlay mount', start: 'listStart', end: 'listEnd' },
  { id: 'firstFrame', label: 'Mount to first frame proxy', start: 'listStart', end: 'firstFrame' },
  { id: 'startToFrame', label: 'Start receipt to first frame proxy', start: 'startReceived', end: 'firstFrame' },
  ...inputs.flatMap(({ id, label }, i) => inputStages(id, label, i)),
  { id: 'iconPatch', label: 'Favicon patch to DOM update', start: 'iconStart', end: 'iconEnd' },
];

const spans = (marks) => stageSpans(CHROME_STAGES, marks);

export async function buildScaleFixture(fixtureDir, log, signal, cwd) {
  await build(
    './node_modules/.bin/vp',
    ['build', '--mode', 'timing', '--config', 'test/bench/scale/vite.config.mjs', '--outDir', fixtureDir],
    log,
    signal,
    cwd,
  );
  const bundle = path.join(fixtureDir, 'overlay.js');
  assert(fs.existsSync(bundle), 'The timing fixture bundle is missing');
  return bundle;
}

function traceSummary(events, file) {
  const { marks, renderer } = traceMarks(events, { ...BENCH_MARK, iconStart: ICON_START, iconEnd: ICON_END });
  assert(renderer, 'Browser trace lacks the start receipt mark');
  const profiles = scriptsIn(events, new Set([renderer.pid + ':' + renderer.tid]));
  assert(
    profiles.some(({ intervals }) => intervals.length),
    'Browser trace lacks renderer CPU samples',
  );
  const activity = rendererActivity(events, renderer);
  return {
    file,
    frames: activity.frames(marks),
    stages: Object.fromEntries(
      spans(marks).map((span) => [
        span.id,
        {
          ms: rounded((span.to - span.from) / 1000),
          top: hotFunctions(profiles, span),
          render: activity.span(span),
        },
      ]),
    ),
  };
}

async function checkView(page, input, icons = false) {
  const view = await page.evaluate((i) => globalThis.scaleFixture.read(i), input);
  assert(view.matches, 'The overlay DOM did not match the expected search frame');
  assert(view.images === (icons ? view.rows : 0), 'Unexpected number of favicon image elements');
  return { rows: view.rows, elements: view.elements, images: view.images };
}

async function trial(page, signal) {
  const evaluate = (fn, ...args) => page.evaluate(fn, ...args);
  await page.evaluate(() => globalThis.scaleFixture.open());
  try {
    const marks = await readOpenMarks(evaluate);
    const counts = { mount: await checkView(page, -1) };
    marks.keys = [];
    marks.frames = [];
    marks.frameProxies = [];
    for (const [i, stage] of inputs.entries()) {
      signal.throwIfAborted();
      const input = await pressKey(page, evaluate, stage.key);
      marks.keys.push(input.key);
      marks.frames.push(input.dom);
      marks.frameProxies.push(input.frame);
      counts[stage.id] = await checkView(page, i);
    }
    await page.evaluate(() => globalThis.scaleFixture.icons());
    marks.iconStart = (await evaluate(waitForMark, ICON_START)).at;
    marks.iconEnd = (await evaluate(waitForMark, ICON_END)).at;
    counts.iconPatch = await checkView(page, inputs.length - 1, true);
    return { ms: Object.fromEntries(spans(marks).map(({ id, from, to }) => [id, to - from])), counts };
  } finally {
    await page.evaluate(() => globalThis.scaleFixture.close());
  }
}

export async function withScaleChrome(executable, bundle, directory, signal, run) {
  return await withBenchChrome(executable, directory, signal, async (browser, version) => {
    const pages = await browser.pages();
    assert(pages.length === 1, 'Scale benchmark requires exactly one headless Chrome tab');
    const [page] = pages;
    const root = await browser.target().createCDPSession();
    await page.bringToFront();
    await page.evaluate(installFixture, ICON_START, ICON_END);
    await page.evaluate(armPage, BENCH_ARMED, BENCH_MARK.key, FRAME_BOUNDARIES, RENDER_TURN_MARK);
    await page.addScriptTag({ path: bundle });
    const measure = () => within(15000, () => trial(page, signal), 'Headless scale trial');
    const result = await run({
      version,
      root,
      configure: (overlay) => page.evaluate((data) => globalThis.scaleFixture.configure(data), overlay),
      async trial() {
        const loadBefore = load();
        return { load: loadBefore, ...(await measure()) };
      },
    });
    assert((await browser.pages()).length === 1, 'Unexpected Chrome tab count after a scale run');
    return result;
  });
}

export async function traceScaleTrial(chrome, output, file) {
  const capture = captureTrace(chrome.root, output, file);
  await capture.start();
  const { load } = await chrome.trial();
  return { ...traceSummary(await capture.stop(), file), load };
}

export async function measureChrome(cases, bundle, output, scratch, signal) {
  return await withScaleChrome(await chromeExecutable(), bundle, scratch, signal, async (chrome) => {
    const results = [];
    for (const { work, overlay } of cases) {
      const { rows, windows } = work;
      const startLoad = load();
      await chrome.configure(overlay);
      const samples = [];
      let counts;
      for (let i = -CHROME_WARMUP; i < CHROME_RUNS; i++) {
        signal.throwIfAborted();
        const { counts: trialCounts, ...sample } = await chrome.trial();
        counts ??= trialCounts;
        assert.deepEqual(trialCounts, counts, 'Overlay element counts varied between trials');
        if (i >= 0) samples.push(sample);
      }
      const file = 'chrome-' + rows + '.trace.json';
      const trace = await traceScaleTrial(chrome, output, file);
      results.push({
        rows,
        windows,
        counts,
        trace,
        load: { start: startLoad, end: load() },
        stages: summarize(CHROME_STAGES, samples),
        trials: samples,
      });
      console.log('Headless overlay measured at ' + rows + ' synthetic rows.');
    }
    return { chrome: chrome.version, browser: results, realTabs: 1, chromeShutdownVerified: true };
  });
}
