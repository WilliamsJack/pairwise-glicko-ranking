import type { App, TFile } from 'obsidian';

import { ResolveDuplicateIdsModal } from '../ui/ResolveDuplicateIdsModal';
import { getNoteId } from './NoteIds';
import { withNotice } from './safe';

const DEFAULT_POOL = 8;

export async function findDuplicateIds(
  app: App,
  files: TFile[],
  propertyName: string,
  opts?: { pool?: number },
): Promise<Map<string, TFile[]>> {
  const pool = Math.max(1, Math.round(opts?.pool ?? DEFAULT_POOL));
  const byId = new Map<string, TFile[]>();

  let idx = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = idx++;
      if (i >= files.length) break;

      const f = files[i];
      const id = await getNoteId(app, f, propertyName);
      if (!id) continue;

      const existing = byId.get(id);
      if (existing) existing.push(f);
      else byId.set(id, [f]);
    }
  };

  await Promise.all(Array.from({ length: pool }, () => worker()));

  const dupes = new Map<string, TFile[]>();
  for (const [id, list] of byId.entries()) {
    if (list.length > 1) dupes.set(id, list);
  }

  return dupes;
}

/**
 * Ensures there are no duplicate note IDs across `files`.
 *
 * Returns:
 * - true: duplicates resolved (or none found), safe to start session
 * - false: user cancelled (session should not start)
 */
export async function ensureUniqueIds(
  app: App,
  files: TFile[],
  propertyName: string,
): Promise<boolean> {
  if (files.length < 2) return true;

  while (true) {
    const dupes = await withNotice('Scanning notes for duplicate IDs...', () =>
      findDuplicateIds(app, files, propertyName),
    );

    if (dupes.size === 0) return true;

    // Handle one duplicate ID group at a time (stable order by ID)
    const ids = Array.from(dupes.keys()).sort((a, b) => a.localeCompare(b));
    const id = ids[0];
    const dupFiles = dupes.get(id) ?? [];

    const res = await new ResolveDuplicateIdsModal(app, {
      noteId: id,
      files: dupFiles,
      propertyName,
    }).openAndGetResult();

    if (res === true) {
      continue;
    }

    return false;
  }
}
