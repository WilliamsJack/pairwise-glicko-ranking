import { Notice } from 'obsidian';

import { debugWarn } from './logger';

/** Show a persistent Notice while `fn` runs, then hide it. */
export async function withNotice<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const notice = new Notice(message, 0);
  try {
    return await fn();
  } finally {
    notice.hide();
  }
}

export function attempt<T>(fn: () => T, context?: string): T | undefined {
  try {
    return fn();
  } catch (e) {
    debugWarn(context ?? 'attempt() caught error', e);
    return undefined;
  }
}

export async function attemptAsync<T>(
  fn: () => Promise<T>,
  context?: string,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    debugWarn(context ?? 'attemptAsync() caught error', e);
    return undefined;
  }
}
