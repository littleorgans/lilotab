import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BrowserProcess, installChrome } from '../chrome/browser.mjs';
import { within } from '../chrome/support.mjs';

export const utc = (date) => date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export const command = (bin, args) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const load = () => loadavg().map((value) => Number(value.toFixed(2)));

export function benchSignal() {
  const controller = new AbortController();
  for (const [name, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.on(name, () => {
      controller.abort(Object.assign(new Error('Interrupted by ' + name), { exitCode }));
    });
  }
  return controller.signal;
}

function tryFileLock(fd) {
  // The helper locks Node's open file description. The kernel releases it when Node closes the fd or exits.
  const [bin, ...args] =
    process.platform === 'linux' ? ['flock', '-n', '-E', '75', '3'] : ['lockf', '-s', '-t', '0', '3'];
  const { status, error } = spawnSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore', fd] });
  if (error) throw error;
  if (status === 75) return false;
  assert.equal(status, 0, 'Could not lock the benchmark guard');
  return true;
}

function reservationOwner(lock) {
  try {
    return fs.readlinkSync(lock);
  } catch (error) {
    // A missing path or a legacy directory has no PID record.
    if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error;
    return null;
  }
}

function ownerGone(owner) {
  const pid = Number(/^pid-([1-9]\d*)$/.exec(owner)?.[1]);
  if (!(pid > 1 && pid <= 0x7fff_ffff)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

function tryReservation(lock, owner) {
  // The guarded symlink publishes the PID atomically and still excludes older runners that use mkdir.
  if (ownerGone(reservationOwner(lock))) fs.rmSync(lock, { force: true });
  try {
    fs.symlinkSync(owner, lock);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

export async function withBenchLock(signal, run) {
  const temp = process.env.TMPDIR;
  assert(
    process.platform !== 'win32' && temp && path.isAbsolute(temp),
    'The benchmark needs a POSIX machine and an absolute TMPDIR',
  );
  const lock = path.join(temp, 'lilotab-bench.lock');
  const owner = 'pid-' + process.pid;
  const minuteMs = 60_000;
  const waitMinutes = 30;
  const deadline = performance.now() + waitMinutes * minuteMs;
  // Keep the guard inode so all waiters lock the same file.
  const guard = fs.openSync(
    lock + '.guard',
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      if (tryFileLock(guard) && tryReservation(lock, owner)) break;
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw Object.assign(
          new Error('Benchmark blocked: lilotab-bench.lock remained held for ' + waitMinutes + ' minutes.'),
          { exitCode: 75 },
        );
      if (attempt === 0)
        console.log('Bench lock is held. Checking once per minute for up to ' + waitMinutes + ' minutes.');
      try {
        await setTimeout(Math.min(minuteMs, remaining), undefined, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
    const release = () => {
      if (reservationOwner(lock) === owner) fs.rmSync(lock, { force: true });
    };
    process.once('exit', release);
    try {
      using scratch = fs.mkdtempDisposableSync(path.join(temp, 'lilotab-bench-'));
      return await run(scratch.path);
    } finally {
      process.off('exit', release);
      release();
    }
  } finally {
    fs.closeSync(guard);
  }
}

function sendSignal(pid, signal) {
  if (!Number.isSafeInteger(pid) || Math.abs(pid) < 2) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function build(bin, args, logPath, signal, cwd) {
  signal.throwIfAborted();
  const log = fs.openSync(logPath, 'wx', 0o600);
  try {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', log, log], detached: true });
    const stop = () => {
      sendSignal(-(child.pid ?? 0), 'SIGINT');
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
        });
      });
      signal.throwIfAborted();
      if (code !== 0) throw Object.assign(new Error('Benchmark build failed with exit ' + code), { exitCode: code });
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    fs.closeSync(log);
  }
}

export const chromeExecutable = () => installChrome({ cache: path.resolve('.smoke/browsers') });

export const BENCH_CHROME_ARGS = [
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--run-all-compositor-stages-before-draw',
];

export async function withBenchChrome(executable, directory, signal, run) {
  signal.throwIfAborted();
  const chrome = new BrowserProcess(directory);
  let browser;
  try {
    browser = await chrome.launch(executable, signal, BENCH_CHROME_ARGS);
    const version = (await browser.version()).split('/').at(-1);
    assert(/^\d+\.\d+\.\d+\.\d+$/.test(version), 'Unexpected Chrome version response');
    return await run(browser, version);
  } finally {
    await closeChrome(browser, chrome);
  }
}

async function closeChrome(browser, chrome) {
  try {
    if (browser?.connected) await within(5000, () => browser.close(), 'Close headless Chrome');
  } catch (error) {
    if (!error.exceeded) throw error;
    // Graceful close can finish during the process check under load.
    console.log('Graceful headless Chrome close timed out. Checking process exit.');
  } finally {
    let exit = await chrome.exited();
    if (exit.alive || exit.remaining.length) {
      console.log('Forcing shutdown of the headless benchmark browser.');
      chrome.forceExit();
      // Check the disposable profile before signalling any remaining process.
      for (const proc of exit.remaining) {
        const pid = Number(proc.trim().split(/\s+/)[0]);
        if (pid === chrome.pid || pid === process.pid || !proc.includes(chrome.profile)) continue;
        sendSignal(pid, 'SIGKILL');
      }
      exit = await chrome.exited();
    }
    assert(
      !exit.alive && !exit.remaining.length && !exit.processCheckError,
      'Could not verify headless Chrome shutdown',
    );
    await within(5000, () => chrome.waitForExit(), 'Reap headless Chrome');
  }
}

export async function closeFixtureServer(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
}
