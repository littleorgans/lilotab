// Appends one job summary line for a cell of .github/workflows/browser-matrix.yml: browser, version and PASS / FAIL /
// KNOWN counts from the harness's results.json, the setup stage that stopped it, or the reason the cell skipped or
// produced no results; a run that stood in a bound shortcut says so.
// Environment: CELL (label), RUN (harness --out folder), VERSION (vendor version, optional), SKIP (reason, optional).
import fs from 'node:fs';
import path from 'node:path';

const { CELL, RUN, VERSION, SKIP, GITHUB_STEP_SUMMARY } = process.env;
const file = path.join(RUN, 'results.json');
let line;
if (SKIP) line = `SKIP: ${SKIP}`;
else if (!fs.existsSync(file)) line = 'FAIL: no results.json; the harness did not start';
else {
  const { metadata, summary, scenarios } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const failed = scenarios.filter((s) => s.status === 'FAIL' && s.id !== 'setup').map((s) => s.id);
  line = [
    [VERSION, metadata.browser].filter(Boolean).join(', engine '),
    metadata.setupError
      ? `SETUP FAIL at ${metadata.setupStage}, no scenario ran: ${metadata.setupError.split('\n')[0]}`
      : `${summary.pass} PASS, ${summary.fail} FAIL, ${summary.known} KNOWN of ${summary.total}`,
    metadata.shortcutSimulated && `shortcut simulated: ${metadata.shortcutSimulated}`,
    failed.length && `failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', ...' : ''}`,
  ]
    .filter(Boolean)
    .join('; ');
}
const row = `- **${CELL}**: ${line}\n`;
process.stdout.write(row);
if (GITHUB_STEP_SUMMARY) fs.appendFileSync(GITHUB_STEP_SUMMARY, row);
