import type { Plugin } from 'obsidian';

import { DEFAULT_SIGMA, glickoUpdate, inflateSigma } from '../domain/rating/GlickoEngine';
import type { GlickoSettings, SessionLayoutMode } from '../settings';
import { DEFAULT_SETTINGS } from '../settings';
import type {
  CohortDefinition,
  GlickoStore,
  MatchResult,
  PlayerSnapshot,
  UndoFrame,
} from '../types';

interface PersistedData {
  version: number;
  settings: GlickoSettings;
  store: GlickoStore;
}

const DEFAULT_STORE: GlickoStore = {
  version: 1,
  cohorts: {},
  cohortDefs: {},
  lastUsedCohortKey: undefined,
};

function normaliseSessionLayout(val: unknown, fallback: SessionLayoutMode): SessionLayoutMode {
  switch (val) {
    case 'reuse-active':
    case 'right-split':
    case 'new-tab':
    case 'new-window':
      return val;
    default:
      return fallback;
  }
}

function normaliseTemplatesFolderPath(val: unknown): string {
  if (typeof val !== 'string') return '';
  let p = val.trim();

  if (p === '/') p = '';

  // Remove leading/trailing slashes for prefix checks
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');

  return p;
}

function mergeSettings(raw?: Partial<GlickoSettings>): GlickoSettings {
  const base: GlickoSettings = { ...DEFAULT_SETTINGS };

  if (!raw) return base;

  // Backwards compatibility: existing installations that have no idPropertyName
  // should default to 'eloId' (preserving their existing note IDs).
  const noIdPropertyName = !('idPropertyName' in raw);

  const out: GlickoSettings = { ...base, ...raw };

  // Deep-merge frontmatterProperties so new keys (e.g. uncertainty) get defaults
  out.frontmatterProperties = {
    ...DEFAULT_SETTINGS.frontmatterProperties,
    ...raw.frontmatterProperties,
  };

  if (noIdPropertyName) {
    out.idPropertyName = 'eloId';
  }

  // Migrate old field names from pre-rebrand settings
  const rawAny = raw as Record<string, unknown>;
  if ('eloIdLocation' in rawAny && !('idLocation' in rawAny)) {
    const loc = rawAny['eloIdLocation'];
    if (loc === 'frontmatter' || loc === 'end') {
      out.idLocation = loc;
    }
  }

  // Validate session layout
  out.sessionLayout = normaliseSessionLayout(raw.sessionLayout, base.sessionLayout);

  out.templatesFolderPath = normaliseTemplatesFolderPath(raw.templatesFolderPath);

  return out;
}

export class PluginDataStore {
  private plugin: Plugin;

  settings: GlickoSettings = { ...DEFAULT_SETTINGS };
  store: GlickoStore = { ...DEFAULT_STORE };

  private _saveQueue: Promise<void> = Promise.resolve();
  private _debounceMs = 300;
  private _saveTimerId: number | null = null;
  private _pendingDebouncePromise: Promise<void> | null = null;
  private _pendingDebounceResolve: (() => void) | null = null;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  async load(): Promise<void> {
    const raw = (await this.plugin.loadData()) as PersistedData | null;

    this.settings = mergeSettings(raw?.settings);
    this.store = raw?.store ?? { ...DEFAULT_STORE };

    if (!raw?.settings || !raw?.store) {
      await this.saveAllImmediate();
    }
  }

  // Internal: write the current snapshot to disk
  private async writePersisted(): Promise<void> {
    const payload: PersistedData = {
      version: 1,
      settings: this.settings,
      store: this.store,
    };
    await this.plugin.saveData(payload);
  }

  // Internal: ensure writes happen one after another
  private enqueueWrite(): Promise<void> {
    this._saveQueue = this._saveQueue
      .then(() => this.writePersisted())
      .catch((e) => {
        console.error('[Glicko] Failed to save data', e);
      });
    return this._saveQueue;
  }

  private scheduleDebouncedSave(): Promise<void> {
    if (this._pendingDebouncePromise !== null) {
      if (this._saveTimerId !== null) window.clearTimeout(this._saveTimerId);
    } else {
      this._pendingDebouncePromise = new Promise<void>((resolve) => {
        this._pendingDebounceResolve = resolve;
      });
    }

    const p = this._pendingDebouncePromise;

    this._saveTimerId = window.setTimeout(() => {
      this._saveTimerId = null;

      const resolve = this._pendingDebounceResolve;
      this._pendingDebounceResolve = null;

      void this.enqueueWrite().finally(() => {
        resolve?.();
        this._pendingDebouncePromise = null;
      });
    }, this._debounceMs);

    return p;
  }

  async saveSettings(): Promise<void> {
    await this.scheduleDebouncedSave();
  }

  async saveStore(): Promise<void> {
    await this.scheduleDebouncedSave();
  }

  async saveAllImmediate(): Promise<void> {
    if (this._saveTimerId !== null) {
      window.clearTimeout(this._saveTimerId);
      this._saveTimerId = null;
    }
    const pending = this._pendingDebouncePromise;
    const resolvePending = this._pendingDebounceResolve;
    this._pendingDebouncePromise = null;
    this._pendingDebounceResolve = null;

    const p = this.enqueueWrite();
    try {
      await p;
    } finally {
      if (pending && resolvePending) resolvePending();
    }
  }

  resetPlayer(cohortKey: string, playerId: string): boolean {
    const cohort = this.store.cohorts[cohortKey];
    if (!cohort?.players[playerId]) return false;
    cohort.players[playerId] = { rating: 1500, matches: 0, wins: 0, sigma: DEFAULT_SIGMA };
    return true;
  }

  ensurePlayer(cohortKey: string, id: string) {
    const cohort = (this.store.cohorts[cohortKey] ??= { players: {} });
    const player = (cohort.players[id] ??= {
      rating: 1500,
      matches: 0,
      wins: 0,
      sigma: DEFAULT_SIGMA,
    });
    // Backfill legacy players that predate sigma tracking
    if (player.sigma === undefined) (player as { sigma: number }).sigma = DEFAULT_SIGMA;
    return { cohort, player };
  }

  applyMatch(
    cohortKey: string,
    aId: string,
    bId: string,
    result: MatchResult,
  ): { winnerId?: string; undo: UndoFrame } {
    const cohort = (this.store.cohorts[cohortKey] ??= { players: {} });

    const a = (cohort.players[aId] ??= { rating: 1500, matches: 0, wins: 0, sigma: DEFAULT_SIGMA });
    const b = (cohort.players[bId] ??= { rating: 1500, matches: 0, wins: 0, sigma: DEFAULT_SIGMA });

    const now = Date.now();

    const undo: UndoFrame = {
      cohortKey,
      a: snapshot(aId, a.rating, a.matches, a.wins, a.sigma, a.lastMatchAt),
      b: snapshot(bId, b.rating, b.matches, b.wins, b.sigma, b.lastMatchAt),
      result,
      ts: now,
    };

    // Inflate sigma for staleness (Glicko-1 RD inflation).
    // Cap is intentionally stabilityThreshold, not DEFAULT_SIGMA: notes don't
    // "lose skill" like human players, so we only allow modest RD inflation to
    // accommodate preference drift. This also prevents the stability progress
    // bar from regressing after long gaps between sessions.
    const cap = this.settings.stabilityThreshold ?? 150;
    const preSigmaA = inflateSigma(a.sigma, now - (a.lastMatchAt ?? now), cap);
    const preSigmaB = inflateSigma(b.sigma, now - (b.lastMatchAt ?? now), cap);

    const sA = result === 'A' ? 1 : result === 'D' ? 0.5 : 0;
    const resA = glickoUpdate(a.rating, b.rating, preSigmaA, preSigmaB, sA);
    const resB = glickoUpdate(b.rating, a.rating, preSigmaB, preSigmaA, 1 - sA);

    a.rating = resA.newRating;
    b.rating = resB.newRating;

    a.matches += 1;
    b.matches += 1;
    if (result === 'A') a.wins += 1;
    if (result === 'B') b.wins += 1;

    a.sigma = resA.newSigma;
    b.sigma = resB.newSigma;
    a.lastMatchAt = now;
    b.lastMatchAt = now;

    const winnerId = result === 'A' ? aId : result === 'B' ? bId : undefined;
    return { winnerId, undo };
  }

  revert(frame: UndoFrame): boolean {
    const cohort = this.store.cohorts[frame.cohortKey];
    if (!cohort) return false;

    const a = cohort.players[frame.a.id];
    const b = cohort.players[frame.b.id];
    if (!a || !b) return false;

    a.rating = frame.a.rating;
    a.matches = frame.a.matches;
    a.wins = frame.a.wins;
    a.sigma = frame.a.sigma;
    a.lastMatchAt = frame.a.lastMatchAt;

    b.rating = frame.b.rating;
    b.matches = frame.b.matches;
    b.wins = frame.b.wins;
    b.sigma = frame.b.sigma;
    b.lastMatchAt = frame.b.lastMatchAt;

    return true;
  }

  listCohortDefs(): CohortDefinition[] {
    return Object.values(this.store.cohortDefs ?? {});
  }

  getCohortDef(key: string): CohortDefinition | undefined {
    return this.store.cohortDefs?.[key];
  }

  upsertCohortDef(def: CohortDefinition): void {
    const defs = (this.store.cohortDefs ??= {});
    def.updatedAt = Date.now();
    defs[def.key] = def;
  }

  setLastUsedCohortKey(key: string | undefined): void {
    this.store.lastUsedCohortKey = key;
  }

  renameCohortKey(oldKey: string, newDef: CohortDefinition): void {
    const newKey = newDef.key;
    if (!newKey || newKey === oldKey) {
      // Nothing to do - just ensure def is saved
      this.upsertCohortDef(newDef);
      return;
    }

    // Migrate cohort data if present
    const oldCohort = this.store.cohorts[oldKey];
    if (oldCohort) {
      const existing = this.store.cohorts[newKey];
      if (!existing) {
        this.store.cohorts[newKey] = oldCohort;
      } else {
        // Merge conservatively: keep existing; add any missing players from old
        for (const [id, player] of Object.entries(oldCohort.players)) {
          if (!existing.players[id]) existing.players[id] = player;
        }
        this.store.cohorts[newKey] = existing;
      }
      delete this.store.cohorts[oldKey];
    }

    // Update cohort defs
    const defs = (this.store.cohortDefs ??= {});
    newDef.updatedAt = Date.now();
    defs[newKey] = newDef;
    if (defs[oldKey]) delete defs[oldKey];

    // Update last used
    if (this.store.lastUsedCohortKey === oldKey) {
      this.store.lastUsedCohortKey = newKey;
    }
  }
}

function snapshot(
  id: string,
  rating: number,
  matches: number,
  wins: number,
  sigma: number,
  lastMatchAt?: number,
): PlayerSnapshot {
  return { id, rating, matches, wins, sigma, lastMatchAt };
}
