import type { App, TFile } from 'obsidian';

import type { IdLocation } from '../settings';
import { debugWarn } from './logger';
import {
  extractIdFromHtmlComment,
  getNoteIdFromFrontmatterCache,
  overwriteNoteIdInHtmlComment,
  removeNoteIdFromFrontmatter,
  removeNoteIdHtmlComments,
  setNoteIdInFrontmatter,
} from './NoteIds';
import { withNotice } from './safe';

const DEFAULT_POOL = 8;

/**
 * Describes where an ID lives (or should live).
 *
 * - If `location` is set, only that location is checked / written.
 * - If `location` is omitted, frontmatter is checked first, then HTML comment
 *   (auto-detect). On write the resolved source location is reused.
 */
export type IdEndpoint = {
  propertyName: string;
  location?: IdLocation;
};

export type IdTransferPlan = {
  file: TFile;
  write?: { location: IdLocation; propertyName: string; id: string };
  remove?: { location: IdLocation; propertyName: string };
  mismatch?: boolean;
};

export type IdTransferPlanResult = {
  from: IdEndpoint;
  to: IdEndpoint;
  plans: IdTransferPlan[];
  wouldUpdate: number;
  mismatches: number;
};

async function readHtmlId(
  app: App,
  file: TFile,
  propertyName: string,
): Promise<string | undefined> {
  try {
    const text = await app.vault.cachedRead(file);
    return extractIdFromHtmlComment(text, propertyName);
  } catch (e) {
    debugWarn(`Failed to read file for ID transfer plan: ${file.path}`, e);
    return undefined;
  }
}

async function planForFile(
  app: App,
  file: TFile,
  from: IdEndpoint,
  to: IdEndpoint,
): Promise<IdTransferPlan | undefined> {
  // Resolve source ID and its actual location
  let sourceId: string | undefined;
  let sourceLocation: IdLocation;

  if (from.location) {
    sourceLocation = from.location;
    sourceId =
      from.location === 'frontmatter'
        ? getNoteIdFromFrontmatterCache(app, file, from.propertyName)
        : await readHtmlId(app, file, from.propertyName);
  } else {
    // Auto-detect: frontmatter first, then HTML comment
    const fmId = getNoteIdFromFrontmatterCache(app, file, from.propertyName);
    if (fmId) {
      sourceId = fmId;
      sourceLocation = 'frontmatter';
    } else {
      sourceId = await readHtmlId(app, file, from.propertyName);
      sourceLocation = 'end';
    }
  }

  if (!sourceId) return undefined;

  // Resolve target location (default: same as where the source was found)
  const targetLocation = to.location ?? sourceLocation;

  // If source and target are the exact same endpoint, nothing to do
  if (sourceLocation === targetLocation && from.propertyName === to.propertyName) {
    return undefined;
  }

  // Read existing target ID (if the target is a different endpoint)
  const targetId =
    targetLocation === 'frontmatter'
      ? getNoteIdFromFrontmatterCache(app, file, to.propertyName)
      : await readHtmlId(app, file, to.propertyName);

  const removeOp = { location: sourceLocation, propertyName: from.propertyName };

  if (!targetId) {
    // Target empty -> write + remove source
    return {
      file,
      write: { location: targetLocation, propertyName: to.propertyName, id: sourceId },
      remove: removeOp,
    };
  }

  if (targetId === sourceId) {
    // Already correct -> just clean up source
    return { file, remove: removeOp };
  }

  // Mismatch: target has a different ID -> keep target, remove source
  return { file, remove: removeOp, mismatch: true };
}

export async function planIdTransfer(
  app: App,
  files: TFile[],
  from: IdEndpoint,
  to: IdEndpoint,
  opts?: { pool?: number },
): Promise<IdTransferPlanResult> {
  const pool = Math.max(1, Math.round(opts?.pool ?? DEFAULT_POOL));

  // Pre-filter optimisation: if source is explicitly frontmatter,
  // only files with that property in the metadata cache need work.
  const candidates =
    from.location === 'frontmatter'
      ? files.filter((f) => !!getNoteIdFromFrontmatterCache(app, f, from.propertyName))
      : files;

  const plans: IdTransferPlan[] = [];
  let mismatches = 0;

  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) break;

      const plan = await planForFile(app, candidates[i], from, to);
      if (!plan) continue;

      plans.push(plan);
      if (plan.mismatch) mismatches += 1;
    }
  };

  await Promise.all(Array.from({ length: pool }, () => worker()));

  plans.sort((a, b) => a.file.path.localeCompare(b.file.path));

  return { from, to, plans, wouldUpdate: plans.length, mismatches };
}

export async function applyIdTransferPlan(
  app: App,
  plan: IdTransferPlanResult,
  opts?: { noticeMessage?: string },
): Promise<{ updated: number; mismatches: number }> {
  return withNotice(opts?.noticeMessage ?? 'Transferring note IDs...', async () => {
    let updated = 0;
    let mismatches = 0;

    for (const p of plan.plans) {
      if (p.mismatch) mismatches += 1;

      // Write first so we don't lose data
      if (p.write) {
        if (p.write.location === 'frontmatter') {
          await setNoteIdInFrontmatter(app, p.file, p.write.id, p.write.propertyName);
        } else {
          await overwriteNoteIdInHtmlComment(app, p.file, p.write.id, p.write.propertyName);
        }
      }

      // Then remove the source
      if (p.remove) {
        if (p.remove.location === 'frontmatter') {
          await removeNoteIdFromFrontmatter(app, p.file, p.remove.propertyName);
        } else {
          await removeNoteIdHtmlComments(app, p.file, p.remove.propertyName);
        }
      }

      updated += 1;
    }

    return { updated, mismatches };
  });
}
