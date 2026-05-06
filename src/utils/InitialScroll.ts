import type { WorkspaceLeaf } from 'obsidian';
import { MarkdownView } from 'obsidian';

import type { ScrollStartMode } from '../types';

export function getPreviewEl(view: MarkdownView): HTMLElement | null {
  const scope = view.contentEl ?? view.containerEl;
  return (
    scope.querySelector('.markdown-reading-view .markdown-preview-view') ??
    scope.querySelector('.markdown-preview-view')
  );
}

function getRenderedRoot(preview: HTMLElement): HTMLElement {
  return (
    preview.querySelector('.markdown-preview-sizer') ??
    preview.querySelector('.markdown-rendered') ??
    preview
  );
}

function findFirstContentImage(root: HTMLElement): HTMLElement | null {
  return root.querySelector('img');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function retryUntil(
  predicate: () => boolean,
  maxTries: number,
  stepMs: number,
): Promise<void> {
  for (let i = 0; i < maxTries; i++) {
    if (predicate()) return;
    await sleep(stepMs);
  }
}

async function scrollToFirstImage(view: MarkdownView): Promise<void> {
  const preview = getPreviewEl(view);
  if (!preview) return;

  preview.scrollTop = 0;

  const findHeading = (): HTMLElement | null => {
    const root = getRenderedRoot(preview);
    return root.querySelector('h1, h2, h3, h4, h5, h6');
  };

  const findImage = (): HTMLElement | null => {
    const root = getRenderedRoot(preview);
    return findFirstContentImage(root);
  };

  // Phase 1: normal short retry (lets the initial viewport render)
  const initialTries = 5;
  const initialStepMs = 50;
  for (let i = 0; i < initialTries; i++) {
    const img = findImage();
    if (img) {
      img.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
      return;
    }
    await sleep(initialStepMs);
  }

  // Phase 2: progressive scroll to force render in long lazily rendered notes
  const stepPx = Math.max(200, Math.floor(preview.clientHeight * 0.8));
  const maxSteps = 250;
  let stalled = 0;

  for (let i = 0; i < maxSteps; i++) {
    const img = findImage();
    if (img) {
      img.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
      return;
    }

    const maxTop = Math.max(0, preview.scrollHeight - preview.clientHeight);
    const atBottom = preview.scrollTop >= maxTop - 2;

    if (atBottom) {
      // Give Obsidian a moment in case scrollHeight is still expanding as it renders
      await sleep(100);
      const newMaxTop = Math.max(0, preview.scrollHeight - preview.clientHeight);
      const stillAtBottom = preview.scrollTop >= newMaxTop - 2;
      if (stillAtBottom) break;
      continue;
    }

    const nextTop = Math.min(preview.scrollTop + stepPx, maxTop);

    // If we cannot make progress, wait a bit and then give up after a few stalls
    if (nextTop <= preview.scrollTop + 1) {
      stalled++;
      if (stalled >= 5) break;
      await sleep(50);
      continue;
    }

    stalled = 0;
    preview.scrollTop = nextTop;
    await sleep(50);
  }

  // Phase 3: fall back to heading
  preview.scrollTop = 0;
  await sleep(0);

  const heading = findHeading();
  if (heading) {
    heading.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
  }
}

async function scrollToFirstHeading(view: MarkdownView): Promise<void> {
  const preview = getPreviewEl(view);
  if (!preview) return;

  await retryUntil(
    () => {
      const root = getRenderedRoot(preview);
      const heading = root.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) {
        heading.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
        return true;
      }
      return false;
    },
    30,
    100,
  );
}

async function scrollAfterFrontmatter(view: MarkdownView): Promise<void> {
  const preview = getPreviewEl(view);
  if (!preview) return;

  await retryUntil(
    () => {
      const root = getRenderedRoot(preview);

      // Scroll to the first real content element after the properties/frontmatter block
      let next = root.querySelector(
        ':scope > :has(.metadata-container, .frontmatter-container, .frontmatter, pre.frontmatter) ~ *',
      );

      while (next && next.scrollHeight <= 0) {
        next = next.nextElementSibling;
      }

      if (next) {
        next.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
        return true;
      }
      return false;
    },
    30,
    100,
  );
}

export async function applyInitialScroll(
  leaf: WorkspaceLeaf,
  mode: ScrollStartMode,
): Promise<void> {
  if (mode === 'none') return;
  const v = leaf.view;
  if (!(v instanceof MarkdownView)) return;

  switch (mode) {
    case 'first-image':
      await scrollToFirstImage(v);
      break;
    case 'first-heading':
      await scrollToFirstHeading(v);
      break;
    case 'after-frontmatter':
      await scrollAfterFrontmatter(v);
      break;
  }
}
