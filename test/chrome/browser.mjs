import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
import { Browser, install } from '@puppeteer/browsers';
import { pause, scrub } from './support.mjs';

export const CHROME_BUILD = '156.0.8078.47';
// Harness profile processes as `pid ppid command` on Windows, which has no pgrep or ps; PowerShell filters by the
// profile path, read from the environment to avoid quoting it.
const windowsProfileProcesses = (profile) =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:HARNESS_PROFILE) } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
    ],
    { encoding: 'utf8', env: { ...process.env, HARNESS_PROFILE: profile } },
  )
    .split(/\r?\n/)
    .filter(Boolean);
// The executable at `chrome`, else the pinned Chrome for Testing, fetched into `cache` once; later runs reuse it offline.
export async function installChrome({ chrome, cache }) {
  const installed = chrome
    ? { executablePath: chrome }
    : await install({ browser: Browser.CHROME, buildId: CHROME_BUILD, cacheDir: cache });
  if (!fs.existsSync(installed.executablePath)) throw new Error('Chrome executable missing; check --chrome');
  return installed.executablePath;
}

export async function evaluateCDP(session, expression, contextId) {
  const reply = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (reply.exceptionDetails)
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result.value;
}

// Chrome extension events are not directly dispatchable over CDP. Find the exact registered callback.
export async function eventListener(session, namespace, event, objectGroup) {
  const proto = await session.send('Runtime.evaluate', { expression: 'Function.prototype', objectGroup });
  const funcs = await session.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup });
  const listeners = await session.send('Runtime.callFunctionOn', {
    objectId: funcs.objects.objectId,
    functionDeclaration:
      'function(namespace,event){return this.filter(f=>{try{return chrome[namespace][event].hasListener(f)}catch{return false}})}',
    arguments: [{ value: namespace }, { value: event }],
  });
  const props = await session.send('Runtime.getProperties', {
    objectId: listeners.result.objectId,
    ownProperties: true,
  });
  const callbacks = props.result.filter((property) => /^\d+$/.test(property.name));
  if (callbacks.length !== 1)
    throw new Error(`Expected one registered ${event} listener; observed ${callbacks.length}`);
  return callbacks[0].value.objectId;
}

export async function closeTarget(root, target) {
  const session = await target.createCDPSession();
  const { targetInfo } = await session.send('Target.getTargetInfo');
  await root.send('Target.closeTarget', { targetId: targetInfo.targetId });
}

// Chrome exposes the extension's isolated world after scripting.executeScript has created it.
export async function extensionWorld(session, extensionId) {
  const contexts = [];
  const remember = ({ context }) => contexts.push(context);
  session.on('Runtime.executionContextCreated', remember);
  try {
    await session.send('Runtime.enable');
    for (const context of contexts) {
      const id = await evaluateCDP(session, 'globalThis.chrome?.runtime?.id', context.id).catch(() => null);
      if (id === extensionId) return context.id;
    }
    throw new Error('Extension isolated world absent');
  } finally {
    session.off('Runtime.executionContextCreated', remember);
  }
}

// One browser process on its own disposable profile under `out`: its launch, its log and what it leaves at exit.
export class BrowserProcess {
  #out;
  #profile;
  #child;
  constructor(out) {
    this.#out = out;
    this.#profile = fs.mkdtempSync(path.join(out, 'profile-'));
  }
  get profile() {
    return this.#profile;
  }
  get pid() {
    return this.#child?.pid;
  }
  get #runningChild() {
    const child = this.#child;
    return child?.pid && child.exitCode === null && child.signalCode === null ? child : undefined;
  }
  forceExit() {
    this.#runningChild?.kill('SIGKILL');
  }
  async waitForExit() {
    const child = this.#runningChild;
    if (child) await once(child, 'exit');
  }
  async launch(executablePath, signal, extraArgs = []) {
    // browser.log takes the browser's stderr and exit from spawn, so a browser that dies during launch still leaves
    // its output, exit code and signal. Spawn fills in the child arguments and stdio after publishing the event.
    const log = path.join(this.#out, 'browser.log');
    const capture = ({ process: child }) => {
      queueMicrotask(() => {
        if (!child.spawnargs?.includes(`--user-data-dir=${this.#profile}`)) return;
        this.#child = child;
        child.stderr?.on('data', (s) => {
          fs.appendFileSync(log, scrub(s));
        });
        child.once('exit', (code, signal) => {
          fs.appendFileSync(log, `browser exited: code ${code}, signal ${signal}\n`);
        });
      });
    };
    diagnostics.subscribe('child_process', capture);
    const launch = puppeteer.launch({
      executablePath,
      // The benchmark owns signal handling so cleanup can run before releasing its lock.
      ...(signal ? { signal, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
      userDataDir: this.#profile,
      headless: true,
      enableExtensions: true,
      pipe: true,
      defaultViewport: null,
      args: [
        // Lets the pipe connection load the build (Extensions.loadUnpacked); branded Chrome ignores --load-extension.
        '--enable-unsafe-extension-debugging',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--screen-info={1920x1080}',
        '--window-size=1440,900',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        // Puppeteer's defaults too, stated so no browser reaches the OS keychain or password store.
        '--use-mock-keychain',
        '--password-store=basic',
        ...extraArgs,
      ],
    });
    const browser = await launch.finally(() => {
      diagnostics.unsubscribe('child_process', capture);
    });
    this.#child = browser.process();
    return browser;
  }
  // After the browser closed: whether the owned child is still running, and any process left using the profile.
  async exited() {
    let alive = false,
      remaining = [],
      processCheckError = null;
    // pgrep matches the profile path in each command line, so output scales with harness processes, never the whole
    // machine; pgrep exits 1 when none match, ps exits 1 when a listed pid has exited since.
    const run = (cmd, args) => {
      try {
        return execFileSync(cmd, args, { encoding: 'utf8' });
      } catch (err) {
        if (err.status === 1 && !err.stderr) return err.stdout;
        throw err;
      }
    };
    const profileProcesses = () => {
      if (process.platform === 'win32') return windowsProfileProcesses(this.#profile);
      const pids = run('pgrep', ['-f', this.#profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]).trim();
      return pids
        ? run('ps', ['-o', 'pid=,ppid=,command=', '-p', pids.split('\n').join(',')])
            .split('\n')
            .filter(Boolean)
        : [];
    };
    // Children can outlive the browser by a moment (Opera's crash reporter on Windows), so a remainder gets 3 s.
    try {
      const end = Date.now() + 3000;
      do {
        await pause(100);
        remaining = profileProcesses();
      } while (remaining.length && Date.now() < end);
      const child = this.#runningChild;
      if (child) {
        alive = true;
        if (process.platform !== 'win32') {
          // POSIX can retain a zombie PID until Node reaps the exited child.
          const state = run('ps', ['-o', 'stat=', '-p', String(child.pid)]).trim();
          alive = state !== '' && !state.startsWith('Z');
        }
      }
    } catch (err) {
      processCheckError = scrub(err.message);
    }
    return { pid: this.pid, alive, remaining, processCheckError };
  }
}
