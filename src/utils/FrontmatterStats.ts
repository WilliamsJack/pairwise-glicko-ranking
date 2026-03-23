import type { App, TFile } from 'obsidian';

import type { FrontmatterPropertiesSettings } from '../settings';
import type { CohortData } from '../types';
import { getNoteId } from './NoteIds';
import { withNotice } from './safe';

type PlayerStats = {
  rating: number;
  uncertainty: number;
  matches: number;
  wins: number;
  rank: number;
};

function anyEnabled(fm: FrontmatterPropertiesSettings): boolean {
  return (
    !!fm.rating.enabled ||
    !!fm.uncertainty.enabled ||
    !!fm.rank.enabled ||
    !!fm.matches.enabled ||
    !!fm.wins.enabled
  );
}

// Standard competition ranking ("1224" style)
export function computeRanksForAll(cohort: CohortData): Map<string, number> {
  const entries = Object.entries(cohort.players);
  entries.sort((a, b) => Math.round(b[1].rating) - Math.round(a[1].rating));

  const map = new Map<string, number>();
  let lastRating: number | undefined = undefined;
  let rank = 0;
  let nextRank = 1;

  for (let i = 0; i < entries.length; i++) {
    const [id, player] = entries[i];
    const rounded = Math.round(player.rating);
    if (lastRating === undefined || rounded !== lastRating) {
      rank = nextRank;
      lastRating = rounded;
    }
    map.set(id, rank);
    nextRank = i + 2;
  }
  return map;
}

// Compute ranks for a subset of players by counting how many players
// have a strictly higher rating (standard competition ranking)
function computeRanksForSubset(cohort: CohortData, playerIds: string[]): Map<string, number> {
  const targets = playerIds
    .map((id) => {
      const r = cohort.players[id]?.rating;
      return { id, rating: r !== undefined ? Math.round(r) : undefined };
    })
    .filter((t): t is { id: string; rating: number } => t.rating !== undefined);

  if (targets.length === 0) return new Map();

  // For each player in the cohort, check if their rating exceeds
  // any target's rating and increment that target's rank counter
  const higherCounts = new Map<string, number>(targets.map((t) => [t.id, 0]));
  for (const player of Object.values(cohort.players)) {
    const rounded = Math.round(player.rating);
    for (const t of targets) {
      if (rounded > t.rating) {
        higherCounts.set(t.id, higherCounts.get(t.id)! + 1);
      }
    }
  }

  const rankMap = new Map<string, number>();
  for (const [id, count] of higherCounts) {
    rankMap.set(id, count + 1);
  }
  return rankMap;
}

function buildProps(fm: FrontmatterPropertiesSettings, stats: PlayerStats): Record<string, number> {
  const out: Record<string, number> = {};

  if (fm.rating.enabled && fm.rating.property) {
    out[fm.rating.property] = Math.round(stats.rating);
  }
  if (fm.uncertainty.enabled && fm.uncertainty.property) {
    out[fm.uncertainty.property] = Math.round(stats.uncertainty);
  }
  if (fm.rank.enabled && fm.rank.property) {
    out[fm.rank.property] = stats.rank;
  }
  if (fm.matches.enabled && fm.matches.property) {
    out[fm.matches.property] = stats.matches;
  }
  if (fm.wins.enabled && fm.wins.property) {
    out[fm.wins.property] = stats.wins;
  }
  return out;
}

async function writeProps(app: App, file: TFile, props: Record<string, number>): Promise<void> {
  if (Object.keys(props).length === 0) return;
  await app.fileManager.processFrontMatter(file, (fmRaw) => {
    const fm = fmRaw as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      fm[k] = v;
    }
  });
}

export async function writeFrontmatterStatsForPair(
  app: App,
  fm: FrontmatterPropertiesSettings,
  cohort: CohortData | undefined,
  aFile?: TFile,
  aId?: string,
  bFile?: TFile,
  bId?: string,
): Promise<void> {
  if (!cohort) return;
  if (!anyEnabled(fm)) return;

  const ids = [aId, bId].filter((id): id is string => !!id);
  const rankMap = computeRanksForSubset(cohort, ids);
  const tasks: Promise<void>[] = [];

  if (aFile && aId) {
    tasks.push(writeFrontmatterStatsForPlayer(app, fm, cohort, aFile, aId, rankMap));
  }
  if (bFile && bId) {
    tasks.push(writeFrontmatterStatsForPlayer(app, fm, cohort, bFile, bId, rankMap));
  }

  await Promise.all(tasks);
}

type FrontmatterUpdatePlan =
  | { op: 'set'; file: TFile; setKey: string; setValue: number; deleteKey?: string }
  | { op: 'delete'; file: TFile; deleteKey: string };

// Shared planner to compute per-file frontmatter updates (set and/or delete).
async function planFrontmatterUpdates(
  app: App,
  files: TFile[],
  valuesById: Map<string, number>,
  newPropName: string,
  oldPropName?: string,
  idPropertyName?: string,
): Promise<{ plans: FrontmatterUpdatePlan[] }> {
  const prop = (newPropName ?? '').trim();
  const oldProp = (oldPropName ?? '').trim();

  const plans: FrontmatterUpdatePlan[] = [];

  for (const file of files) {
    const id = await getNoteId(app, file, idPropertyName ?? 'glickoId');
    if (!id) continue;

    const fcRaw: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
    const fmCache =
      fcRaw && typeof fcRaw === 'object' ? (fcRaw as Record<string, unknown>) : undefined;

    // Removal-only mode: delete oldProp if present.
    if (!prop && oldProp) {
      const hasOld = typeof fmCache?.[oldProp] !== 'undefined';
      if (hasOld) {
        plans.push({ op: 'delete', file, deleteKey: oldProp });
      }
      continue;
    }

    // Nothing to do if no new prop.
    if (!prop) continue;

    // Only consider files that have a value provided for this id.
    const newVal = valuesById.get(id);
    if (typeof newVal === 'undefined') continue;

    const curNewRaw: unknown = fmCache ? fmCache[prop] : undefined;
    const curNew =
      typeof curNewRaw === 'number'
        ? curNewRaw
        : typeof curNewRaw === 'string'
          ? parseInt(curNewRaw, 10)
          : undefined;

    const hasOld = !!oldProp && oldProp !== prop && typeof fmCache?.[oldProp] !== 'undefined';

    const needSet = curNew !== newVal;
    const needRemoveOld = hasOld;

    if (needSet || needRemoveOld) {
      if (needSet) {
        plans.push({
          op: 'set',
          file,
          setKey: prop,
          setValue: newVal,
          ...(needRemoveOld ? { deleteKey: oldProp } : {}),
        });
      } else {
        plans.push({ op: 'delete', file, deleteKey: oldProp });
      }
    }
  }

  return { plans };
}

// Compute how many files would be updated by a rename/remove operation.
export async function previewCohortFrontmatterPropertyUpdates(
  app: App,
  files: TFile[],
  valuesById: Map<string, number>,
  newPropName: string,
  oldPropName?: string,
  idPropertyName?: string,
): Promise<{ wouldUpdate: number }> {
  const { plans } = await planFrontmatterUpdates(
    app,
    files,
    valuesById,
    newPropName,
    oldPropName,
    idPropertyName,
  );
  return { wouldUpdate: plans.length };
}

// Generic bulk updater for frontmatter properties based on a values map.
// If oldPropName is provided, it will be removed if present (rename).
// If newPropName is empty and oldPropName is provided, performs removal only.
export async function updateCohortFrontmatterProperties(
  app: App,
  files: TFile[],
  valuesById: Map<string, number>,
  newPropName: string,
  oldPropName?: string,
  idPropertyName?: string,
): Promise<{ updated: number }> {
  const { plans } = await planFrontmatterUpdates(
    app,
    files,
    valuesById,
    newPropName,
    oldPropName,
    idPropertyName,
  );

  let updated = 0;
  for (const p of plans) {
    await app.fileManager.processFrontMatter(p.file, (yamlRaw) => {
      const yaml = yamlRaw as Record<string, unknown>;
      if (p.op === 'set') {
        yaml[p.setKey] = p.setValue;
        if (p.deleteKey) {
          delete yaml[p.deleteKey];
        }
      } else {
        delete yaml[p.deleteKey];
      }
    });
    updated += 1;
  }

  return { updated };
}

/**
 * Convenience wrapper around updateCohortFrontmatterProperties that shows a working
 * notice while the update runs. Allows custom notice text.
 */
export async function updateCohortFrontmatter(
  app: App,
  files: TFile[],
  valuesById: Map<string, number>,
  newPropName: string,
  oldPropName?: string,
  noticeMessage?: string,
  idPropertyName?: string,
): Promise<{ updated: number }> {
  return withNotice(noticeMessage ?? 'Updating frontmatter...', () =>
    updateCohortFrontmatterProperties(
      app,
      files,
      valuesById,
      newPropName,
      oldPropName,
      idPropertyName,
    ),
  );
}

export async function updateCohortRanksInFrontmatter(
  app: App,
  cohort: CohortData | undefined,
  files: TFile[],
  newPropName: string,
): Promise<{ updated: number }> {
  if (!cohort) return { updated: 0 };
  const rankMap = computeRanksForAll(cohort);
  return updateCohortFrontmatterProperties(app, files, rankMap, newPropName);
}

export async function writeFrontmatterStatsForPlayer(
  app: App,
  fm: FrontmatterPropertiesSettings,
  cohort: CohortData,
  file: TFile,
  playerId: string,
  precomputedRankMap: Map<string, number>,
): Promise<void> {
  if (!anyEnabled(fm)) return;
  const p = cohort.players[playerId];
  if (!p) return;
  const rankMap = precomputedRankMap;
  const props = buildProps(fm, {
    rating: p.rating,
    uncertainty: p.sigma,
    matches: p.matches,
    wins: p.wins,
    rank: rankMap.get(playerId) ?? rankMap.size,
  });
  await writeProps(app, file, props);
}
