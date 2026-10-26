// storage.session envelope, storage.local settings and the options page clear request (03-components 3.2, 06-data).

import { loadSettings, onSettingsChanged, saveSettings } from '../../../browser/settings.ts';
import {
  IDLE_QUEUE,
  PREP_BUDGET_MS,
  PROTOCOL,
  SESSION_KEY,
  parseOptionsRequest,
  saveStep,
  type LiveFacts,
  type OptionsReply,
  type RequestId,
  type SaveInput,
  type SessionEnvelope,
  type SessionStore,
  type SettingsStore,
} from '../../../core/index.ts';
import { report, reportCode } from '../../diagnostics.ts';
import type { Ingress } from '../../ingress.ts';
import { settleBy } from '../clock/index.ts';

export const sessionStore: SessionStore = {
  load: async () => (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY],
  write: (envelope) => chrome.storage.session.set({ [SESSION_KEY]: envelope }),
};

export const settingsStore: SettingsStore = {
  load: loadSettings,
  save: saveSettings,
  // The session area holds only the worker's own writes, so only settings changes reach ingress (06 3).
  onChanged(sink) {
    onSettingsChanged((settings) => {
      sink((at) => ({ kind: 'settingsChanged', at, settings }));
    });
  },
};

// No content script needs settings; called at every evaluation, since persistence is undocumented (06 3).
export function restrictLocal(): void {
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
}

export interface Saver {
  checkpoint(envelope: SessionEnvelope, reply: RequestId | null): void;
  awaitAnswer(request: RequestId, answer: (ok: boolean) => void): void;
}

// Performs the core saveQueue's write and wait effects and routes its answers (06 5.1). The retry wait is a plain
// timeout outside the interaction timers; a worker stop during it loses the retry (06 5.1 bound).
export function createSaver(store: SessionStore): Saver {
  let queue = IDLE_QUEUE;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const answers = new Map<RequestId, (ok: boolean) => void>();

  function feed(input: SaveInput): void {
    const next = saveStep(queue, input);
    queue = next.queue;
    for (const effect of next.effects) {
      switch (effect.kind) {
        case 'write':
          store.write(effect.envelope).then(
            () => {
              feed({ kind: 'saved' });
            },
            (error: unknown) => {
              feed({ kind: 'failed', quota: /quota/i.test(String(error)) });
            },
          );
          break;
        case 'wait':
          wait = setTimeout(() => {
            feed({ kind: 'retryDue' });
          }, effect.ms);
          break;
        case 'cancelWait':
          clearTimeout(wait);
          break;
        case 'answer':
          answers.get(effect.request)?.(effect.ok);
          answers.delete(effect.request);
          break;
        case 'diagnostic':
          report(effect.entry);
          break;
      }
    }
  }

  return {
    checkpoint: (envelope, reply) => {
      feed({ kind: 'checkpoint', envelope, reply });
    },
    awaitAnswer: (request, answer) => answers.set(request, answer),
  };
}

// The options page by origin and path, never by the absence of a tab (05-events 4.7). Its page comes from the
// manifest, so this check follows wherever the options page is declared.
function fromOptions(sender: chrome.runtime.MessageSender): boolean {
  const manifest = chrome.runtime.getManifest();
  const page = manifest.options_ui?.page ?? manifest.options_page;
  const origin = chrome.runtime.getURL('').replace(/\/$/, '');
  if (!page || sender.id !== chrome.runtime.id || sender.origin !== origin || !sender.url) return false;
  return sender.url.split(/[?#]/)[0] === chrome.runtime.getURL(page);
}

// "Clear now" (06 5.3): sender and shape checks before ingress; the request id is the entry's ingress seq; the page
// is answered when that checkpoint's save settles, or at once when live facts fail.
export function registerClear(ingress: Ingress, saver: Saver, liveFacts: () => Promise<LiveFacts>): void {
  chrome.runtime.onMessage.addListener((message, sender, reply: (r: OptionsReply) => void) => {
    if (!fromOptions(sender) || !parseOptionsRequest(message)) return false;
    const answer = (ok: boolean) => {
      reply({ v: PROTOCOL, t: 'cleared', ok });
    };
    ingress(async (at, request) => {
      const live = await settleBy(liveFacts(), at + PREP_BUDGET_MS);
      if (!live.ok) {
        reportCode(live.cause === 'timeout' ? 'prepTimeout' : 'prepFailed', 'clear');
        answer(false);
        return null;
      }
      saver.awaitAnswer(request, answer);
      return { kind: 'clearData', at, live: live.value, request };
    });
    return true; // keeps reply valid until the save settles
  });
}
