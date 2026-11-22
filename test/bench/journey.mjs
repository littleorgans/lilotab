import assert from 'node:assert/strict';
import path from 'node:path';
import { BENCH_ARMED, BENCH_MARK, BENCH_OPEN, TIMING_KEY } from '../../src/browser/timing.ts';
import { POPUP_PAGE, WELCOME_PAGE } from '../../src/worker/names.ts';
import { closeTarget, evaluateCDP, extensionWorld } from '../chrome/browser.mjs';
import { within } from '../chrome/support.mjs';

export const SEARCH_KEYS = ['a', 'l', 'p', 'h'];
export const MOVES = 3;
export const INPUT_FRAME_MARK = 'lilotab:input-frame';
export const OPEN_FRAME_MARK = 'lilotab:open-frame';
export const RENDER_TURN_MARK = 'lilotab:render-turn';
export const FRAME_BOUNDARIES = { [BENCH_MARK.frame]: INPUT_FRAME_MARK, [BENCH_MARK.listEnd]: OPEN_FRAME_MARK };
const stamp = () => performance.timeOrigin + performance.now();
const deadline = 8000;

// Runs in the worker or the isolated world. Observe the buffered marks too, so fast work can finish before CDP asks.
export function waitForMark(name, after = 0) {
  const stamp = (entry) => performance.timeOrigin + entry.startTime;
  const existing = performance.getEntriesByName(name, 'mark').findLast((entry) => stamp(entry) >= after);
  if (existing) return { at: stamp(existing), detail: existing.detail };
  return new Promise((resolve, reject) => {
    const observer = new PerformanceObserver((list) => {
      const entry = list.getEntriesByName(name).find((candidate) => stamp(candidate) >= after);
      if (!entry) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve({ at: stamp(entry), detail: entry.detail });
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Missing measurement mark ' + name));
    }, 5000);
    observer.observe({ type: 'mark', buffered: true });
  });
}

export function armPage(flag, keyMark, boundaries, renderTurn) {
  globalThis[flag] = true;
  if (boundaries) {
    const mark = performance.mark.bind(performance);
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => mark(data);
    performance.mark = (name, options) => {
      const entry = mark(name, options);
      const endpoint = boundaries[name];
      if (endpoint)
        requestAnimationFrame(() => {
          mark(renderTurn);
          // This task runs after the rendering turn that called the animation callback.
          channel.port2.postMessage(endpoint);
        });
      return entry;
    };
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted) performance.mark(keyMark, { detail: event.key });
    },
    { capture: true },
  );
}

export async function readOpenMarks(evaluate) {
  const marks = {};
  for (const name of ['startReceived', 'listStart', 'listEnd']) {
    marks[name] = (await evaluate(waitForMark, BENCH_MARK[name])).at;
  }
  marks.firstFrame = (await evaluate(waitForMark, OPEN_FRAME_MARK)).at;
  return marks;
}

export async function pressKey(page, evaluate, key, expectFrame = true) {
  const after = await evaluate(stamp);
  await page.keyboard.press(key);
  const input = await evaluate(waitForMark, BENCH_MARK.key, after);
  assert.equal(input.detail, key, 'The overlay did not receive the expected trusted key');
  if (!expectFrame) return { key: input.at };
  const dom = (await evaluate(waitForMark, BENCH_MARK.frame, input.at)).at;
  const frame = (await evaluate(waitForMark, INPUT_FRAME_MARK, dom)).at;
  return { key: input.at, dom, frame };
}

export function requestCommand(mark, message) {
  performance.mark(mark);
  return globalThis.chrome.runtime.sendMessage(message);
}

function readList() {
  const root = globalThis.chrome.dom.openOrClosedShadowRoot(document.activeElement);
  const list = root?.querySelector('ul.search:not(.copy)');
  const options = Array.from(list?.children ?? []);
  return {
    titles: options.map((row) => row.querySelector('.title')?.textContent),
    selected: options.findIndex((row) => row.getAttribute('aria-selected') === 'true'),
    query: root?.activeElement?.value,
    shown: !!list?.closest('.panel.shown'),
  };
}

// Runs in the service worker. Chrome may finish navigation while the remainder of the tabs are still being created.
function loadTabs(urls, windowId) {
  return new Promise((resolve, reject) => {
    const complete = new Set();
    const ids = [];
    const finish = (error) => {
      globalThis.chrome.tabs.onUpdated.removeListener(updated);
      clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(ids);
    };
    const check = () => {
      if (ids.length === urls.length && ids.every((id) => complete.has(id))) finish();
    };
    const updated = (id, change) => {
      if (change.status !== 'complete') return;
      complete.add(id);
      check();
    };
    const timer = setTimeout(() => {
      finish(new Error('Local fixture tabs did not load'));
    }, 20000);
    globalThis.chrome.tabs.onUpdated.addListener(updated);
    void (async () => {
      for (const url of urls) {
        const tab = await globalThis.chrome.tabs.create({ url, windowId, active: false });
        ids.push(tab.id);
        if (tab.status === 'complete') complete.add(tab.id);
        check();
      }
    })().catch(finish);
  });
}

export function waitForGesture(key, after, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const finish = (error, record) => {
      globalThis.chrome.storage.onChanged.removeListener(changed);
      clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(record);
    };
    const read = (value) => {
      const record = JSON.parse(value ?? '[]').findLast((entry) => entry.epoch >= after - 1);
      if (record) finish(null, record);
    };
    const changed = (changes, area) => {
      if (area === 'local' && changes[key]) read(changes[key].newValue);
    };
    const timer = setTimeout(() => {
      finish(new Error('Gesture timing record did not reach storage'));
    }, timeout);
    globalThis.chrome.storage.onChanged.addListener(changed);
    globalThis.chrome.storage.local.get(key).then((stored) => {
      read(stored[key]);
    }, finish);
  });
}

async function stopWorker(browser, target) {
  let destroyed;
  try {
    await within(
      deadline,
      async () => {
        const gone = new Promise((resolve) => {
          destroyed = (closed) => {
            if (closed === target) resolve();
          };
          browser.on('targetdestroyed', destroyed);
        });
        await (await target.worker()).close();
        await gone;
      },
      'Stop extension worker',
    );
  } finally {
    browser.off('targetdestroyed', destroyed);
  }
}

export async function fixtureTabs(browser, server, count, extensionPath = path.resolve('dist-timing')) {
  const root = await browser.target().createCDPSession();
  const [page] = await browser.pages();
  const base = 'http://127.0.0.1:' + server.address().port;
  const groups = ['Atlas', 'Alpha', 'Alpha', 'Algebra'];
  const fixtures = Array.from({ length: count }, (_, i) => {
    const name = groups[i % groups.length] + ' ' + String(i).padStart(3, '0');
    return { name, title: 'H1 ' + name, url: base + '/?name=' + encodeURIComponent(name) };
  });
  await page.goto(fixtures[0].url);
  const { id } = await root.send('Extensions.loadUnpacked', { path: extensionPath });
  const extension = 'chrome-extension://' + id + '/';
  const isWorker = (target) => target.type() === 'service_worker' && target.url().startsWith(extension);
  const workerTarget = () => browser.waitForTarget(isWorker, { timeout: deadline });
  const welcome = await browser.waitForTarget((target) => target.url() === extension + WELCOME_PAGE, {
    timeout: deadline,
  });
  await closeTarget(root, welcome);
  await page.bringToFront();
  const worker = await (await workerTarget()).worker();
  const source = await worker.evaluate(
    async (url) => (await globalThis.chrome.tabs.query({})).find((tab) => tab.url === url),
    fixtures[0].url,
  );
  assert(source?.active, 'Source fixture is not the active tab');

  // A real toolbar action grants activeTab, as in the smoke harness. Close its unmeasured setup popup before filling tabs.
  const { targetInfos } = await root.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  const targetId = targetInfos.find((target) => target.url === fixtures[0].url)?.targetId;
  assert(targetId, 'Source tab CDP target missing');
  const [popup] = await Promise.all([
    browser.waitForTarget((target) => target.url().startsWith(extension + POPUP_PAGE + '#'), { timeout: deadline }),
    root.send('Extensions.triggerAction', { id, targetId }),
  ]);
  await closeTarget(root, popup);
  await page.bringToFront();
  const openTabs = await worker.evaluate(async () => (await globalThis.chrome.tabs.query({})).map(({ id }) => id));
  assert.deepEqual(openTabs, [source.id], 'Expected only the source tab before filling the fixture');
  const extra = await within(
    24000,
    () =>
      worker.evaluate(
        loadTabs,
        fixtures.slice(1).map((fixture) => fixture.url),
        source.windowId,
      ),
    'Create local tabs',
  );
  for (const [i, tabId] of [source.id, ...extra].entries()) fixtures[i].tabId = tabId;
  const loaded = await worker.evaluate(async () =>
    (await globalThis.chrome.tabs.query({})).map(({ id, title, status }) => ({ id, title, status })),
  );
  assert.equal(loaded.length, count, 'Unexpected total tab count');
  for (const fixture of fixtures)
    assert(
      loaded.some((tab) => tab.id === fixture.tabId && tab.title === fixture.title && tab.status === 'complete'),
      'Fixture did not load',
    );
  return { root, page, id, source, fixtures, workerTarget };
}

export async function runTrial(browser, fixture, boot, trace, signal) {
  const { page, id, source, fixtures, workerTarget } = fixture;
  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  const previous = await workerTarget();
  const origin = await (
    await previous.worker()
  ).evaluate(async (id) => {
    await globalThis.chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      world: 'ISOLATED',
      func: () => 0,
    });
    return performance.timeOrigin;
  }, source.id);
  const session = await page.createCDPSession();
  try {
    const context = await extensionWorld(session, id);
    const own = (fn, ...args) =>
      evaluateCDP(session, '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', context);
    await own(armPage, BENCH_ARMED, BENCH_MARK.key, FRAME_BOUNDARIES, RENDER_TURN_MARK);
    if (boot === 'cold') await stopWorker(browser, previous);
    await trace?.start();
    assert.equal(
      await own(requestCommand, BENCH_MARK.request, BENCH_OPEN),
      true,
      'The search entry did not accept the fixture message',
    );
    const worker = await (await workerTarget()).worker();
    const marks = await readOpenMarks(own);
    marks.request = (await own(waitForMark, BENCH_MARK.request)).at;
    let view = await own(readList);
    assert(
      view.shown && view.query === '' && view.selected >= 0 && view.titles.length === fixtures.length,
      'The visible unfiltered overlay did not contain all fixture tabs',
    );

    const keys = [];
    const frames = [];
    const frameProxies = [];
    async function keypress(key, expectFrame) {
      signal.throwIfAborted();
      const input = await pressKey(page, own, key, expectFrame);
      keys.push(input.key);
      if (expectFrame) {
        frames.push(input.dom);
        frameProxies.push(input.frame);
      }
    }

    let query = '';
    for (const key of SEARCH_KEYS) {
      await keypress(key, true);
      query += key;
      const next = await own(readList);
      const titles = fixtures.filter((it) => it.name.toLowerCase().includes(query)).map((it) => it.title);
      assert(next.shown && next.query === query, 'The overlay did not show the expected query');
      assert.deepEqual(next.titles.toSorted(), titles.toSorted(), 'Rendered rows do not match the fixture query');
      assert.equal(next.selected, 0, 'Search did not highlight the first result');
      view = next;
    }
    for (let i = 0; i < MOVES; i++) {
      await keypress('ArrowDown', true);
      const next = await own(readList);
      assert(next.shown && next.query === query, 'The overlay lost the search view');
      assert.deepEqual(next.titles, view.titles, 'A selection move changed the search results');
      assert.equal(next.selected, (view.selected + 1) % view.titles.length, 'The selection did not move one row');
      view = next;
    }
    const target = fixtures.find((it) => it.title === view.titles[view.selected]);
    assert(target && target.tabId !== source.id, 'A different tab must be selected at commit');
    await keypress('Enter', false);
    marks.activated = (await worker.evaluate(waitForMark, BENCH_MARK.activated, marks.request)).at;
    await trace?.stop();

    const workerMarks = await worker.evaluate(
      (names) =>
        Object.fromEntries(
          Object.entries(names).map(([name, mark]) => {
            const last = performance.getEntriesByName(mark, 'mark').at(-1);
            return [name, last ? performance.timeOrigin + last.startTime : null];
          }),
        ),
      {
        entry: BENCH_MARK.entry,
        queryStart: BENCH_MARK.queryStart,
        queryEnd: BENCH_MARK.queryEnd,
        startSent: BENCH_MARK.startSent,
      },
    );
    const record = await worker.evaluate(waitForGesture, TIMING_KEY, marks.request);
    const workerOrigin = await worker.evaluate(() => performance.timeOrigin);
    assert.equal(workerOrigin !== origin, boot === 'cold', 'Unexpected worker lifetime');
    if (boot === 'cold') assert(workerOrigin >= marks.request, 'The worker restarted before the cold request');
    assert.equal(record.firstOfBoot, boot === 'cold', 'Timing log disagrees with worker lifetime');
    assert(
      record.entry === 'search' &&
        record.tabs === fixtures.length &&
        record.windows === 1 &&
        record.attempts.length === 1 &&
        record.attempts[0].host === 'overlay' &&
        record.attempts[0].ready !== null,
      'Gesture timing log did not see the expected overlay route',
    );
    assert(
      record.reason === 'enter' &&
        record.switched &&
        record.target?.tabId === target.tabId &&
        record.target.result === 'done',
      'Gesture did not commit to the selected tab',
    );
    const active = await worker.evaluate(
      async (windowId) => (await globalThis.chrome.tabs.query({ active: true, windowId }))[0]?.id,
      source.windowId,
    );
    assert.equal(active, target.tabId, 'Chrome did not activate the selected fixture tab');
    return {
      marks: { ...marks, ...workerMarks, workerOrigin, keys, frames, frameProxies },
      gateWaited: record.gateWaited,
    };
  } finally {
    await session.detach();
  }
}
