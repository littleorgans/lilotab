// Options page: edits settings through the core settings rules and sends the clear request (03-components 3.3).

import '../page.css';
import { loadSettings, onSettingsChanged, saveSettings } from '../../browser/settings.ts';
import {
  CLEAR_ANSWER_MS,
  DEFAULTS,
  FIELDS,
  FLIP_ONLY,
  IDLE_EDIT,
  PROTOCOL,
  SCHEMA,
  canEdit,
  editStep,
  inactive,
  parseOptionsReply,
  type EditInput,
  type OptionsRequest,
  type SettingField,
  type Settings,
  type SettingsEdit,
} from '../../core/index.ts';
import { OPTIONS_TEXT as T, SETTING_TEXT } from '../../strings.ts';
import { el, group, row } from '../dom.ts';
import { shortcutBlock } from '../shortcut.ts';
import { timingGroup } from './timing.ts';

// The settings edit value; every change goes through step, which renders and performs the core's effects.
let edit: SettingsEdit = IDLE_EDIT;
const controls = new Map<SettingField, { line: HTMLElement; set: HTMLFieldSetElement }>();

const newer = el('p', { class: 'notice', hidden: '' }, [T.newer]);
const saveStatus = el('p', { class: 'status', role: 'status' });
const restore = el('button', { type: 'button' }, [T.restore]);
const flipOnly = el('p', { class: 'hint', hidden: '' }, [T.flipOnly]);

// A projection of the edit value; disabled until the first read and over newer data (C-DATA-10). Open tab list
// leaves the Flip to last tab rows in place, dimmed and out of the tab order (C-SET-19).
function render(e: SettingsEdit): void {
  document.documentElement.className = e.shown.theme; // the page follows Theme (C-SET-06)
  for (const [field, { line, set }] of controls) {
    const off = inactive(e.shown, field);
    line.classList.toggle('off', off);
    set.disabled = !canEdit(e) || off;
    for (const input of set.querySelectorAll('input')) input.checked = input.value === String(e.shown[field]);
  }
  restore.disabled = !canEdit(e);
  flipOnly.hidden = !FLIP_ONLY.some((f) => inactive(e.shown, f));
  newer.hidden = e.source !== 'newer';
  saveStatus.textContent = e.status === 'saveFailed' ? T.saveFailed : ''; // C-SET-18
}

// One validated object, one write; the core decides rollback and readback for a rejected save (06 4.6, C-SET-18).
function step(input: EditInput): void {
  const next = editStep(edit, input);
  edit = next.edit;
  render(edit);
  for (const effect of next.effects) {
    if (effect.kind === 'write') {
      void saveSettings(effect.stored).catch(() => {
        step({ kind: 'failed', write: effect.write });
      });
    } else {
      read();
    }
  }
}

// The stored value through the core read rules (06 4.3); a failed read changes nothing.
function read(): void {
  void loadSettings().then(
    (raw) => {
      step({ kind: 'read', raw });
    },
    () => undefined,
  );
}

// One segmented control per SCHEMA field: a fieldset of radios sharing the field's name, so arrow keys move and the
// row is one tab stop. Its values come only from SCHEMA, its names and unit from the catalogue (06 4.1).
function settingRow(field: SettingField): HTMLElement {
  const { label, unit } = SETTING_TEXT[field];
  const names: Readonly<Record<string, string>> = SETTING_TEXT[field].values;
  const values: readonly Settings[SettingField][] = SCHEMA[field].values;
  const options = values.map((v) => {
    const input = el('input', { type: 'radio', name: field, value: String(v) });
    input.addEventListener('change', () => {
      step({ kind: 'edit', patch: { [field]: v } });
    });
    return el('label', { class: 'option' }, [input, names[String(v)] ?? String(v)]);
  });
  const labelId = `label-${field}`;
  const set = el('fieldset', { 'aria-labelledby': labelId }, [el('div', { class: 'track' }, options)]);
  if (unit !== undefined) {
    set.setAttribute('aria-describedby', `unit-${field}`);
    set.append(el('span', { class: 'unit', id: `unit-${field}` }, [unit]));
  }
  const line = row(label, field === 'quickTap' ? [flipOnly] : [], set, labelId);
  controls.set(field, { line, set });
  return line;
}

// FIELDS order is the page order.
const settingsGroup = (section: 'switching' | 'appearance'): HTMLElement =>
  group(
    T.sections[section],
    FIELDS.filter((f) => SCHEMA[f].section === section).map((f) => settingRow(f)),
  );

// "Clear now": one request, answered when the cleared history saves; silence past 5 s reads as not cleared (06 5.3).
function historyRow(): HTMLElement {
  const button = el('button', { type: 'button' }, [T.clear]);
  const status = el('p', { class: 'status', role: 'status' });
  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = T.clearing;
    const request: OptionsRequest = { v: PROTOCOL, t: 'clear' };
    const silence = new Promise<null>((resolve) => setTimeout(resolve, CLEAR_ANSWER_MS, null));
    void Promise.race([chrome.runtime.sendMessage(request), silence])
      .then(parseOptionsReply, () => null)
      .then((reply) => {
        status.textContent = reply?.ok === true ? T.cleared : T.notCleared; // C-DATA-09
        button.disabled = false;
      });
  });
  return row(T.history, [el('p', { class: 'hint' }, [T.historyKept]), status], button);
}

function restoreRow(): HTMLElement {
  // Writes { version } (C-SET-11, 06 4.2).
  restore.addEventListener('click', () => {
    step({ kind: 'edit', patch: DEFAULTS });
  });
  return row(T.defaults, [el('p', { class: 'hint' }, [T.restoreScope])], restore);
}

document.title = T.title;
document.body.append(
  el('main', {}, [
    el('h1', {}, [T.title]),
    newer,
    el('section', { class: 'card' }, [shortcutBlock()]),
    settingsGroup('switching'),
    saveStatus,
    settingsGroup('appearance'),
    group(T.sections.history, [historyRow(), restoreRow()]),
    ...(import.meta.env.MODE === 'timing' ? [timingGroup()] : []), // inline, so release builds drop it (src/browser/timing.ts)
  ]),
);

// Another options page, or this one, saved: refresh from the stored value; a removed key reads as absent (06 3).
onSettingsChanged((raw) => {
  step({ kind: 'read', raw });
});
render(edit);
read();
