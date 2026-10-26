import { pause } from './support.mjs';
import { HELD } from './chrome.mjs';
import { state, probe, active } from './behavior.mjs';

const OPEN = 'cubic-bezier(0.2, 0, 0, 1)',
  CLOSE = 'cubic-bezier(0.4, 0, 1, 1)';
const hasTime = (a, ms, easing) =>
  a.timing.duration === ms && (a.timing.easing === easing || a.frames.some((f) => f.easing === easing));
const opacity = (a, from, to) => a.frames[0]?.opacity === String(from) && a.frames.at(-1)?.opacity === String(to);
const noMotion = (p) => p.animations.length === 0;
const liveRows = (x) => x.lists?.some((l) => !l.hidden && l.rows > 0);
function swapProof(x, p) {
  const rows = x.lists ?? [],
    records = p.animations.filter((a) => hasTime(a, 90, OPEN));
  return (
    records.length >= 4 &&
    records.some((a) => opacity(a, 0, 1)) &&
    records.some((a) => opacity(a, 1, 0)) &&
    !!x.field &&
    !!x.strip &&
    liveRows(x) &&
    rows.some((l) => l.hidden && l.inert && l.rows > 0 && l.ids.length === 0) &&
    x.head?.height > 0
  );
}
export function motionScenarios(c, e, add) {
  for (const flavor of ['overlay', 'popup'])
    for (const [setting, osReduce] of [
      ['never', false],
      ['never', true],
      ['always', false],
      ['always', true],
      ['system', false],
      ['system', true],
    ]) {
      const id = `9-motion-${flavor}-${setting}-${osReduce ? 'reduce' : 'normal'}`,
        moves = setting === 'never' || (setting === 'system' && !osReduce);
      add(
        id,
        `${setting}, OS ${osReduce ? 'reduce' : 'normal'}: ${moves ? '100 ms open, 90 ms two way head and row swap; overlay 70 ms cancel' : 'no animation on open, swap or cancel'} (AC-25; C-A11Y-04, C-SET-08)`,
        async () => {
          const h = await c.open(flavor, { reduceMotion: setting, osReduce, freeze: [100] }),
            opened = await state(c, h),
            openProbe = await probe(c, h);
          const openRecords = openProbe.animations.length
            ? openProbe.animations
            : (opened.animations ?? []).map((a) => ({ ...a, source: 'Live Animation effect' }));
          let openPass = moves
            ? openRecords.length > 0 && openRecords.every((a) => hasTime(a, 100, OPEN))
            : noMotion(openProbe) && openRecords.length === 0;
          if (moves && flavor === 'overlay')
            openPass &&= openRecords.length === 1 && openRecords[0].frames.some((f) => /0\.98/.test(f.transform ?? ''));
          if (moves && flavor === 'popup')
            openPass &&= openRecords.every((a) => !a.frames.some((f) => f.transform && f.transform !== 'none'));
          await c.resume(h);
          await pause(120);
          const countBefore = (await probe(c, h)).animations.length;
          await c.key(h, 'ArrowDown', HELD.modifier);
          await pause(20);
          const afterSelection = (await probe(c, h)).animations.length;
          await c.resetProbe(h, [90]);
          await c.key(h, 'f', HELD.modifier);
          await pause(15);
          const search = await state(c, h),
            searchProbe = await probe(c, h);
          const artifact = await c.shot(h, `${id}-swap.png`);
          const forward = search.search && (moves ? swapProof(search, searchProbe) : noMotion(searchProbe));
          await c.resume(h);
          await pause(110);
          await c.resetProbe(h, [90]);
          await c.key(h, 'f', HELD.modifier);
          await pause(15);
          const back = await state(c, h),
            backProbe = await probe(c, h);
          const reverse = !back.search && (moves ? swapProof(back, backProbe) : noMotion(backProbe));
          const headStable =
            opened.headLayoutHeight > 0 &&
            opened.headLayoutHeight === search.headLayoutHeight &&
            back.headLayoutHeight === search.headLayoutHeight;
          await c.resume(h);
          await pause(110);
          await c.resetProbe(h, [70]);
          await c.key(h, 'Backspace', HELD.modifier);
          await pause(15);
          const closing = await state(c, h),
            closeProbe = await probe(c, h);
          const closePass =
            flavor === 'popup'
              ? !closing.connected
              : moves
                ? closing.connected &&
                  closing.inert &&
                  closeProbe.animations.length === 1 &&
                  hasTime(closeProbe.animations[0], 70, CLOSE) &&
                  opacity(closeProbe.animations[0], 1, 0) &&
                  closeProbe.animations[0].frames.every(
                    (f) => !f.transform || f.transform === 'none' || f.transform === 'scale(1)',
                  )
                : !closing.connected && noMotion(closeProbe);
          await c.resume(h);
          const ended = await c.waitRemoved(h);
          return {
            pass:
              openPass &&
              forward &&
              reverse &&
              headStable &&
              closePass &&
              countBefore === afterSelection &&
              !ended.connected,
            measured: {
              setting,
              osReduce,
              moves,
              opened,
              openProbe,
              search,
              searchProbe,
              back,
              backProbe,
              closing,
              closeProbe,
              ended,
              checks: {
                openPass,
                forward,
                reverse,
                headStable,
                closePass,
                noOpenReplay: countBefore === afterSelection,
              },
            },
            artifacts: [artifact],
          };
        },
      );
    }
  for (const flavor of ['overlay', 'popup'])
    add(
      `9-switch-cut-${flavor}`,
      'A commit to another tab cuts immediately without a 70 ms close animation (AC-25; C-HOLD-09)',
      async () => {
        const h = await c.open(flavor, { freeze: [70] }),
          before = await state(c, h);
        // With Recent order the second command reaches another row before release in list mode.
        await c.command();
        await pause(30);
        const target = await state(c, h);
        await c.resetProbe(h, [70]);
        await c.release(h);
        await pause(15);
        const after = await state(c, h),
          p = await probe(c, h);
        const activeTab = await active(c);
        return {
          pass:
            target.selected?.title !== 'H1 Source' &&
            target.selected?.title === activeTab.title &&
            !after.connected &&
            p.animations.every((a) => a.timing.duration !== 70),
          measured: { before, target, after, active: activeTab, probe: p },
        };
      },
    );
  for (const flavor of ['overlay', 'popup'])
    for (const during of ['open', 'swap', 'close'])
      add(
        `9-os-change-${flavor}-${during}`,
        'Match system cancels live motion and removes temporary rows immediately when OS reduce becomes enabled (AC-25; C-A11Y-04, C-SET-08)',
        async () => {
          const h = await c.open(flavor, {
            reduceMotion: 'system',
            osReduce: false,
            freeze: during === 'open' ? [100] : [],
          });
          if (during !== 'open') await pause(120);
          if (during === 'swap') {
            await c.resetProbe(h, [90]);
            await c.key(h, 'f', HELD.modifier);
          }
          if (during === 'close') {
            await c.resetProbe(h, [70]);
            await c.key(h, 'Backspace', HELD.modifier);
          }
          await pause(10);
          const before = await state(c, h),
            pBefore = await probe(c, h);
          if (flavor === 'popup' && during === 'close') {
            return {
              pass: !before.connected,
              measured: {
                before,
                pBefore,
                method: 'Real popup closes immediately; no popup close animation exists to interrupt',
              },
            };
          }
          await c.media(h, true);
          await pause(15);
          const after = await state(c, h),
            pAfter = await probe(c, h);
          const hadMotion = before.animations?.some((a) => ['running', 'paused'].includes(a.state));
          const clean =
            !(after.animations ?? []).some((a) => ['running', 'paused'].includes(a.state)) &&
            !(after.lists ?? []).some((l) => l.hidden);
          await c.resume(h);
          return {
            pass: hadMotion && clean && (during === 'close' ? !after.connected : after.connected),
            measured: { before, after, pBefore, pAfter, hadMotion, clean },
          };
        },
      );
  add(
    '10-cancel-cleanup',
    'Sensors, ping and focus clean up while the 70 ms overlay cancel fade remains visible (AC-16; C-SW-02)',
    async () => {
      const h = await c.open('overlay');
      await c.release(h);
      await pause(25);
      const opened = await state(c, h),
        before = await probe(c, h);
      await c.resetProbe(h, [70]);
      await c.key(h, 'Escape');
      await pause(15);
      const during = await state(c, h),
        p = await probe(c, h),
        focus = await c.sourcePage.evaluate(() => ({
          active: document.activeElement?.id,
          focused: document.hasFocus(),
        }));
      // The paired key events must now reach the page even though a retiring panel is still connected.
      await c.sourcePage.evaluate(() => (window.__h1Page = []));
      await c.key(h, 'ArrowDown');
      const pageEvents = await c.sourcePage.evaluate(() => window.__h1Page);
      await c.resume(h);
      const after = await c.waitRemoved(h);
      return {
        pass:
          opened.listFocused &&
          during.connected &&
          during.inert &&
          p.activeSensors.length === 0 &&
          p.intervals.every((x) => !x.active) &&
          focus.active === 'page-input' &&
          pageEvents.filter((x) => x.key === 'ArrowDown').length === 2 &&
          !after.connected,
        measured: { opened, before, during, probe: p, focus, pageEvents, after },
      };
    },
  );
  add(
    '9-swap-interruption',
    'Rapid F toggles cancel superseded swaps; close clears visual copies and all animations (AC-25; C-A11Y-04)',
    async () => {
      const h = await c.open('overlay');
      await pause(110);
      await c.resetProbe(h, [90]);
      await c.key(h, 'f', HELD.modifier);
      await c.key(h, 'f', HELD.modifier);
      await c.key(h, 'f', HELD.modifier);
      await pause(15);
      const mid = await state(c, h),
        pMid = await probe(c, h);
      await c.key(h, 'Escape');
      const ended = await c.waitRemoved(h),
        pEnd = await probe(c, h);
      return {
        pass:
          mid.search &&
          mid.fieldFocused &&
          pMid.animations.some((a) => a.state === 'cancelled') &&
          (mid.lists ?? []).filter((l) => l.hidden).length === 1 &&
          !ended.connected &&
          pEnd.animations.every((a) => !['running', 'paused'].includes(a.state)),
        measured: { mid, pMid, ended, pEnd },
      };
    },
  );
}
