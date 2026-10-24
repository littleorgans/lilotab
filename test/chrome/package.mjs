// AC-30 to AC-32: release package (07-tests 2.2).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POPUP_PAGE } from '../../src/worker/names.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const KIB = 1024;
const sizes = (files) =>
  files.map((file) => {
    const bytes = fs.readFileSync(file);
    return { file: path.relative(root, file), raw: bytes.length, gzip: zlib.gzipSync(bytes, { level: 9 }).length };
  });
const total = (rows) => ({ raw: rows.reduce((n, r) => n + r.raw, 0), gzip: rows.reduce((n, r) => n + r.gzip, 0) });
const releaseZip = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  return path.join(root, 'release', `${pkg.name}-${pkg.version}.zip`);
};
// The overlay file the worker injects, by the path its bundle names.
function overlayFile(dist) {
  for (const file of fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'))) {
    const m = /"(src\/hosts\/overlay\/[\w./-]+\.js)"/.exec(fs.readFileSync(path.join(dist, 'assets', file), 'utf8'));
    if (m) return m[1];
  }
  throw new Error('No worker bundle names the overlay file');
}
// The popup page's module graph: its entry script and the modules it preloads.
function popupScripts(dist, popupHtml) {
  const html = fs.readFileSync(path.join(dist, popupHtml), 'utf8');
  return [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
}

export function packageScenarios(c, e, add) {
  add(
    'AC-30-popup-title',
    'The toolbar title and the popup title carry the product name from the manifest (KB-12)',
    async () => {
      const h = await c.open('popup');
      const popup = await c.own(h, 'document.title'),
        action = await c.workerEval(`chrome.action.getTitle({tabId:${c.source.id}})`);
      return { pass: popup === c.manifest.name && action === c.manifest.name, measured: { popup, action } };
    },
  );
  const SIZE_ROWS = [
    ['overlay', () => [path.join(c.ext, overlayFile(c.ext))]],
    ['popup', () => popupScripts(c.ext, POPUP_PAGE).map((f) => path.join(c.ext, f))],
  ];
  for (const [host, files] of SIZE_ROWS)
    add(
      `AC-31-size-${host}-script`,
      `The ${host} host's first interaction script is at most 50 KiB raw and 20 KiB gzip (C-PERF-02)`,
      () => {
        const each = sizes(files()),
          sum = total(each);
        return { pass: each.length > 0 && sum.raw <= 50 * KIB && sum.gzip <= 20 * KIB, measured: { each, sum } };
      },
    );
  add('AC-31-size-release-zip', 'The release ZIP is at most 100 KiB (C-PERF-02)', () => {
    const [zip] = sizes([releaseZip()]);
    return { pass: zip.raw <= 100 * KIB, measured: zip };
  });
  add(
    'AC-32-no-exposure',
    'The release manifest has no web accessible resources, and a web page cannot load the overlay file (C-SEC-05)',
    async () => {
      const manifest = JSON.parse(execFileSync('unzip', ['-p', releaseZip(), 'manifest.json']));
      const url = c.extensionBase + overlayFile(c.ext);
      const load = await c.sourcePage.evaluate(
        (u) =>
          fetch(u).then(
            (r) => `loaded ${r.status}`,
            () => 'refused',
          ),
        url,
      );
      return { pass: !('web_accessible_resources' in manifest) && load === 'refused', measured: { load } };
    },
  );
  add(
    'AC-32-overlay-classic',
    'The overlay file the worker injects evaluates as a classic script with no imports (C-SEC-05)',
    () => {
      const file = overlayFile(c.ext),
        source = fs.readFileSync(path.join(c.ext, file), 'utf8');
      let classic = true;
      try {
        new vm.Script(source, { filename: file });
      } catch {
        classic = false;
      }
      const dynamic = /\bimport\s*\(/.test(source);
      return { pass: classic && !dynamic, measured: { file, classic, dynamic } };
    },
  );
}
