// Developer builds log diagnostics to the console; release builds record none (C-SET-14).

import { diagnostic, type Diagnostic, type DiagnosticCode } from '../core/index.ts';
import { PRODUCT } from '../strings.ts';

export function report(entry: Diagnostic): void {
  if (import.meta.env.DEV) console.debug(PRODUCT, entry.code, entry.detail);
}

export const reportCode = (code: DiagnosticCode, detail: string | null = null): void => {
  report(diagnostic(code, detail));
};

// An adapter call that threw: never stops the drain; developer builds see it.
export function fault(error: unknown): void {
  if (import.meta.env.DEV) console.error(PRODUCT, error);
}
