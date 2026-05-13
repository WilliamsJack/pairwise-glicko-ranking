import type { App, OpenViewState, ViewState, WorkspaceLeaf } from 'obsidian';
import { TFile } from 'obsidian';

import { debugWarn } from '../../utils/logger';

const TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 50;

type ResolveOpts = {
  timeoutMs?: number;
  pollMs?: number;
};

const nextFrame = (): Promise<void> =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// ---- Minimal models of Bases internals ----

type BasesControllerLike = {
  results?: unknown;
  initialScan?: unknown;
};

type BasesViewLike = {
  getViewType: () => string;
  controller?: BasesControllerLike;
};

type BasesViewState = { file?: string; viewName?: string };

function getBasesView(leaf: WorkspaceLeaf): BasesViewLike | undefined {
  const view = leaf.view as unknown as BasesViewLike;
  return view.getViewType() === 'bases' ? view : undefined;
}

function leafMatchesBase(leaf: WorkspaceLeaf, basePath: string, viewName: string): boolean {
  const vs: ViewState = leaf.getViewState();
  if (vs.type !== 'bases') return false;

  const st = (vs.state ?? {}) as BasesViewState;
  return st.file === basePath && st.viewName === viewName;
}

// ---- Results extraction ----

type ResultsLike = {
  size: number;
  keys: () => IterableIterator<unknown>;
};

function isResultsLike(value: unknown): value is ResultsLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ResultsLike).size === 'number' &&
    typeof (value as ResultsLike).keys === 'function'
  );
}

function getUserLeaf(app: App): WorkspaceLeaf | null {
  return app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(false);
}

async function openBaseIntoLeaf(
  app: App,
  leaf: WorkspaceLeaf,
  baseFile: TFile,
  viewName: string,
): Promise<void> {
  // Make the target leaf active so openLinkText opens into it.
  app.workspace.setActiveLeaf(leaf, { focus: true });
  await nextFrame();

  const linktext = `${baseFile.path}#${viewName}`;
  const openState: OpenViewState = { active: true };

  await app.workspace.openLinkText(linktext, baseFile.path, false, openState);

  // Give Obsidian time to attach the view and controller.
  await nextFrame();
  await nextFrame();
}

async function awaitBasesControllerReady(
  leaf: WorkspaceLeaf,
  basesView: BasesViewLike,
  basePath: string,
  viewName: string,
  timeoutMs: number,
  pollMs: number,
): Promise<BasesControllerLike> {
  const started = performance.now();
  const deadline = started + timeoutMs;

  while (performance.now() < deadline) {
    if (leafMatchesBase(leaf, basePath, viewName)) {
      const controller = basesView.controller;
      if (controller) return controller;
    }
    await sleep(pollMs);
  }

  throw new Error('[Glicko][Bases] Timed out waiting for Bases controller');
}

/**
 * Wait for Bases to finish producing results.
 *
 * Completion condition:
 * - results container exists, and
 * - initialScan === false.
 *
 * On timeout:
 * - if results exist, return settled=false (best-effort),
 * - otherwise throw.
 */
async function waitForResultsToSettle(
  controller: BasesControllerLike,
  timeoutMs: number,
  pollMs: number,
): Promise<{ settled: boolean }> {
  const started = performance.now();
  const deadline = started + timeoutMs;

  while (true) {
    const resultsOk = isResultsLike(controller.results);
    const scan = controller.initialScan;
    const scanOk = typeof scan === 'boolean';

    if (resultsOk && scanOk && scan === false) return { settled: true };

    if (performance.now() >= deadline) {
      if (resultsOk) return { settled: false };
      throw new Error('[Glicko][Bases] Timed out waiting for Bases results container');
    }

    await sleep(pollMs);
  }
}

function extractMarkdownFilesFromControllerResults(controller: BasesControllerLike): TFile[] {
  const resultsUnknown = controller.results;
  if (!isResultsLike(resultsUnknown)) return [];

  const out: TFile[] = [];
  for (const k of resultsUnknown.keys()) {
    if (k instanceof TFile && k.extension.toLowerCase() === 'md') out.push(k);
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Resolve Markdown files from a .base file + view name by opening the Base,
 * waiting for results to settle, extracting `TFile`s, then cleaning up.
 */
export async function resolveFilesFromBaseView(
  app: App,
  basePath: string,
  viewName: string,
  opts?: ResolveOpts,
): Promise<TFile[]> {
  const af = app.vault.getAbstractFileByPath(basePath);
  if (!(af instanceof TFile) || af.extension.toLowerCase() !== 'base') {
    throw new Error(`[Glicko][Bases] Not a .base file: ${basePath}`);
  }
  const baseFile = af;

  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;

  const previousLeaf = getUserLeaf(app);
  let leaf: WorkspaceLeaf | null = null;

  try {
    leaf = app.workspace.getLeaf('tab');
    if (!leaf) throw new Error('[Glicko][Bases] Could not create a workspace leaf');

    await openBaseIntoLeaf(app, leaf, baseFile, viewName);

    const basesView = getBasesView(leaf);
    if (!basesView) {
      const viewType = leaf.view.getViewType();
      throw new Error(`[Glicko][Bases] Unexpected view type: ${String(viewType)}`);
    }

    const controller = await awaitBasesControllerReady(
      leaf,
      basesView,
      baseFile.path,
      viewName,
      timeoutMs,
      pollMs,
    );

    await waitForResultsToSettle(controller, timeoutMs, pollMs);

    return extractMarkdownFilesFromControllerResults(controller);
  } finally {
    // Restore the user's previous leaf
    try {
      if (leaf && previousLeaf && previousLeaf !== leaf) {
        app.workspace.setActiveLeaf(previousLeaf, { focus: true });
        await nextFrame();
      }
    } catch (e) {
      debugWarn('Bases resolver: failed to restore previous leaf', e);
    }

    try {
      leaf?.detach();
    } catch (e) {
      debugWarn('Bases resolver: failed to detach temporary leaf', e);
    }
  }
}
