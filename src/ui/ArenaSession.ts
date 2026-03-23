import type { App, EventRef, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Platform, TFile } from 'obsidian';

import { pickNextPairIndices } from '../domain/matchmaking/Matchmaker';
import { computeSurprise, DEFAULT_SIGMA } from '../domain/rating/GlickoEngine';
import type GlickoPlugin from '../main';
import type { FrontmatterPropertiesSettings } from '../settings';
import { effectiveFrontmatterProperties } from '../settings';
import type { MatchResult, ScrollStartMode, SessionMatchData, UndoFrame } from '../types';
import { writeFrontmatterStatsForPair } from '../utils/FrontmatterStats';
import { applyInitialScroll, getPreviewEl } from '../utils/InitialScroll';
import { debugWarn } from '../utils/logger';
import { ensureNoteId, getNoteId } from '../utils/NoteIds';
import { attempt, attemptAsync } from '../utils/safe';
import { installScrollSync } from '../utils/ScrollSync';
import type { ArenaLayoutHandle } from './LayoutManager';
import { ArenaLayoutManager } from './LayoutManager';

export default class ArenaSession {
  private app: App;
  private plugin: GlickoPlugin;
  private cohortKey: string;
  private files: TFile[];

  private leftFile?: TFile;
  private rightFile?: TFile;
  private lastPair?: [string, string];

  private leftLeaf!: WorkspaceLeaf;
  private rightLeaf!: WorkspaceLeaf;

  private idByPath = new Map<string, string>();

  private undoStack: UndoFrame[] = [];
  private overlayEl?: HTMLElement;
  private overlayWin?: Window;
  private popoutUnloadHandler?: () => void;
  private keydownHandler = (ev: KeyboardEvent) => this.onKeydown(ev);

  private layoutHandle?: ArenaLayoutHandle;

  private liveNotices: Notice[] = [];

  private shortcutsPausedToastShown = false;

  // Mobile (phone) mode: two tabs + switch/win bar
  private lastVisibleSide: 'left' | 'right' = 'left';
  private activeLeafChangeRef?: EventRef;

  // Button refs for keyboard "press-in" flash
  private leftBtn?: HTMLButtonElement;
  private drawBtn?: HTMLButtonElement;
  private rightBtn?: HTMLButtonElement;
  private undoBtn?: HTMLButtonElement;
  private endBtn?: HTMLButtonElement;

  // Mobile-only buttons
  private switchBtn?: HTMLButtonElement;
  private winBtn?: HTMLButtonElement;
  private mobileTitleEl?: HTMLElement;

  private pressTimers = new WeakMap<HTMLButtonElement, number>();

  private scrollSyncCleanup?: () => void;

  private stabilityBarFillEl?: HTMLElement;

  private startedAt = Date.now();

  constructor(app: App, plugin: GlickoPlugin, cohortKey: string, files: TFile[]) {
    this.app = app;
    this.plugin = plugin;
    this.cohortKey = cohortKey;
    this.files = files.slice();
  }

  async start() {
    // Create arena layout per settings and platform
    const requested = this.plugin.settings.sessionLayout ?? 'new-tab';

    const layoutMode = Platform.isPhone ? 'new-tab' : requested;

    // Create arena layout
    const mgr = new ArenaLayoutManager(this.app);
    this.layoutHandle = await mgr.create(layoutMode);

    this.leftLeaf = this.layoutHandle.leftLeaf;
    this.rightLeaf = this.layoutHandle.rightLeaf;

    // Resolve the correct document/window for UI and keyboard capture.
    const doc =
      this.leftLeaf.view.containerEl.ownerDocument ??
      this.rightLeaf.view.containerEl.ownerDocument ??
      this.layoutHandle.doc ??
      document;
    const win = doc.defaultView ?? this.layoutHandle.win ?? window;

    this.overlayWin = win;

    // Pin both leaves during the session
    this.leftLeaf.setPinned(true);
    this.rightLeaf.setPinned(true);

    this.mountOverlay(doc);
    this.plugin.registerDomEvent(win, 'keydown', this.keydownHandler, true);

    // Mobile: Update bar to reflect the currently visible note
    if (Platform.isPhone) {
      this.activeLeafChangeRef = this.app.workspace.on('active-leaf-change', () =>
        this.updateOverlay(),
      );
    }

    // If the user closes a pop-out window, end the session automatically.
    if (win !== window) {
      this.popoutUnloadHandler = () => void this.plugin.endSession();
      this.plugin.registerDomEvent(win, 'beforeunload', this.popoutUnloadHandler);
    }

    await this.preloadFileIds();
    this.pickNextPair();
    await this.openCurrent();
    this.updateOverlay();
    this.updateStabilityBar();
  }

  /**
   * Read note IDs for all files up-front so the matchmaker can look up
   * actual stats on the first pair pick, allowing the information-gain
   * algorithm to prioritise genuinely new notes.
   */
  private async preloadFileIds(): Promise<void> {
    const propName = this.plugin.settings.idPropertyName;
    await Promise.all(
      this.files.map(async (f) => {
        const id = await getNoteId(this.app, f, propName);
        if (id) this.idByPath.set(f.path, id);
      }),
    );
  }

  async end(opts?: { forUnload?: boolean }) {
    this.clearScrollSync();

    // Remove mobile UI workspace listeners
    if (this.activeLeafChangeRef) {
      try {
        this.app.workspace.offref(this.activeLeafChangeRef);
      } catch (e) {
        debugWarn('Failed to unregister active-leaf-change listener', e);
      }
      this.activeLeafChangeRef = undefined;
    }

    // Remove listeners from the correct window
    if (this.overlayWin) {
      this.overlayWin.removeEventListener('keydown', this.keydownHandler, true);
      if (this.popoutUnloadHandler) {
        this.overlayWin.removeEventListener('beforeunload', this.popoutUnloadHandler);
        // Hide any toast we created while in the popout (so they don't reattach to the main window)
        for (const n of this.liveNotices) {
          n.hide();
        }
      }
    }

    this.popoutUnloadHandler = undefined;

    this.unmountOverlay();

    // Unpin leaves
    attempt(() => this.leftLeaf.setPinned(false), 'Unpin left leaf');
    attempt(() => this.rightLeaf.setPinned(false), 'Unpin right leaf');

    // Only detach/cleanup panes when not unloading the plugin (as per guidelines)
    if (!opts?.forUnload) {
      try {
        await this.layoutHandle?.cleanup();
      } catch (e) {
        debugWarn('Layout cleanup failed (panes may already be detached)', e);
      }
    }

    if (this.stabilityJitterAnim) {
      this.stabilityJitterAnim.cancel();
      this.stabilityJitterAnim = undefined;
      this.stabilityBarFillEl?.classList.remove('is-surprise');
    }

    this.overlayWin = undefined;
    this.liveNotices = [];
    this.undoStack = [];
    this.lastVisibleSide = 'left';
  }

  public getCohortKey(): string {
    return this.cohortKey;
  }

  public captureSessionData(): SessionMatchData {
    return {
      cohortKey: this.cohortKey,
      matches: this.undoStack.slice(),
      idToPath: new Map([...this.idByPath.entries()].map(([path, id]) => [id, path])),
      fileCount: this.files.length,
      startedAt: this.startedAt,
    };
  }

  onFileRenamed(oldPath: string, newFile: TFile) {
    // Update our id map to the new path
    const id = this.idByPath.get(oldPath);
    if (id) {
      this.idByPath.delete(oldPath);
      this.idByPath.set(newFile.path, id);
    }
    // Update labels if visible
    if (this.leftFile?.path === oldPath) this.leftFile = newFile;
    if (this.rightFile?.path === oldPath) this.rightFile = newFile;
    this.lastPair =
      this.leftFile && this.rightFile
        ? ([this.leftFile.path, this.rightFile.path].sort() as [string, string])
        : undefined;
    this.updateOverlay();
  }

  public onFileDeleted(deletedPath: string): void {
    void this.handleFileDeleted(deletedPath);
  }

  private async handleFileDeleted(deletedPath: string): Promise<void> {
    const before = this.files.length;

    this.files = this.files.filter((f) => f.path !== deletedPath);
    this.idByPath.delete(deletedPath);

    const deletedWasVisible =
      this.leftFile?.path === deletedPath || this.rightFile?.path === deletedPath;

    if (this.files.length === before && !deletedWasVisible) return;

    if (this.files.length < 2) {
      this.showToast('Not enough notes left to continue - ending session.');
      void this.plugin.endSession();
      return;
    }

    // If the deleted note was one of the current pair, pick a new pair immediately
    if (deletedWasVisible) {
      this.lastPair = undefined;

      // Pre-emptively clear the stale leaf so Obsidian's cleanup
      // doesn't race with our setViewState and overwrite the new file.
      const staleLeaf = this.leftFile?.path === deletedPath ? this.leftLeaf : this.rightLeaf;
      await staleLeaf.setViewState({ type: 'empty', state: {} });

      const deletedName = deletedPath.replace(/.*\//, '').replace(/\.md$/i, '');
      this.showToast(`Match skipped - "${deletedName}" was deleted.`);
      this.pickNextPair();
      await this.openCurrent();
    }

    this.updateOverlay();
  }

  private async openCurrent() {
    if (!this.leftFile || !this.rightFile) return;

    this.clearScrollSync();

    // Lazily ensure note IDs only for the notes being displayed
    await Promise.all([this.getIdForFile(this.leftFile), this.getIdForFile(this.rightFile)]);

    await Promise.all([
      this.openInReadingMode(this.leftLeaf, this.leftFile),
      this.openInReadingMode(this.rightLeaf, this.rightFile),
    ]);

    if (this.getCohortSyncScrollEnabled() && !Platform.isPhone) {
      const leftView = this.leftLeaf.view;
      const rightView = this.rightLeaf.view;
      if (leftView instanceof MarkdownView && rightView instanceof MarkdownView) {
        const leftEl = getPreviewEl(leftView);
        const rightEl = getPreviewEl(rightView);
        if (leftEl && rightEl) {
          this.scrollSyncCleanup = installScrollSync(leftEl, rightEl);
        }
      }
    }

    // Phone UX: start a new pair on the left note
    if (Platform.isPhone) {
      this.app.workspace.setActiveLeaf(this.leftLeaf, { focus: true });
      this.lastVisibleSide = 'left';
    }
  }

  private getCohortScrollStart(): ScrollStartMode {
    const def = this.plugin.dataStore.getCohortDef(this.cohortKey);
    return def?.scrollStart ?? 'none';
  }

  private async openInReadingMode(leaf: WorkspaceLeaf, file: TFile) {
    // Force Reading Mode
    await attemptAsync(
      () =>
        leaf.setViewState({
          type: 'markdown',
          state: { file: file.path, mode: 'preview' },
          active: false,
        }),
      `Open file in reading mode: ${file.path}`,
    );

    // Apply initial scroll behaviour
    const mode = Platform.isPhone ? 'none' : this.getCohortScrollStart();
    await applyInitialScroll(leaf, mode);
  }

  private clearScrollSync(): void {
    try {
      this.scrollSyncCleanup?.();
    } catch (e) {
      debugWarn('Scroll sync cleanup failed', e);
    }
    this.scrollSyncCleanup = undefined;
  }

  // ---- Helpers - Indicate convergence on stable ratings ----

  private computeStabilityPercent(): number {
    const n = this.files.length;
    if (n < 2) return 0;

    const cohort = this.plugin.dataStore.store.cohorts[this.cohortKey];
    const players = cohort ? Object.values(cohort.players) : [];

    let playedSum = 0;
    for (const p of players) {
      playedSum += p.sigma;
    }

    // Files not yet in the player table carry full uncertainty
    const unmatched = Math.max(0, n - players.length);
    const avgSigma = (playedSum + unmatched * DEFAULT_SIGMA) / n;

    const stableSigma = this.plugin.settings.stabilityThreshold ?? 150;
    const range = DEFAULT_SIGMA - stableSigma;
    return Math.max(0, Math.min(100, ((DEFAULT_SIGMA - avgSigma) / range) * 100));
  }

  // Measure "surprise" - how much the outcome deviated from what we would predict.
  // Used to trigger a visual jitter on the stability bar.
  private computeSurpriseForFrame(undo: UndoFrame): number {
    return computeSurprise(undo.a.rating, undo.b.rating, undo.result);
  }

  private stabilityJitterAnim?: Animation;

  private updateStabilityBar(surprise = 0): void {
    if (!this.stabilityBarFillEl) return;

    const pct = this.computeStabilityPercent();

    // Colour tiers
    this.stabilityBarFillEl.classList.toggle('is-mid', pct >= 60 && pct < 90);
    this.stabilityBarFillEl.classList.toggle('is-high', pct >= 90);

    const win = this.overlayWin ?? window;

    // Cancel any in-flight jitter so we don't fight with a new update
    if (this.stabilityJitterAnim) {
      this.stabilityJitterAnim.cancel();
      this.stabilityJitterAnim = undefined;
      this.stabilityBarFillEl?.classList.remove('is-surprise');
    }

    const jitterEnabled = this.plugin.settings.surpriseJitter ?? true;
    const prefersReduced = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

    // Jitter: slide back, overshoot forward, then settle at the true value.
    // Amplitude scales with surprise (0–1) so mild upsets barely wobble.
    const SURPRISE_THRESHOLD = 0.15;
    if (jitterEnabled && surprise > SURPRISE_THRESHOLD) {
      this.stabilityBarFillEl.classList.add('is-surprise');

      if (prefersReduced) {
        this.stabilityBarFillEl.setCssProps({ '--stability-width': `${pct}%` });
        this.stabilityJitterAnim = this.stabilityBarFillEl.animate([], { duration: 750 });
      } else {
        const amp = Math.min(8, surprise * 16);
        const back1 = Math.max(0, pct - amp);
        const fwd1 = Math.min(100, pct + amp * 0.6);
        const back2 = Math.max(0, pct - amp * 0.5);
        const fwd2 = Math.min(100, pct + amp * 0.3);

        this.stabilityJitterAnim = this.stabilityBarFillEl.animate(
          [
            { width: `${back1}%` },
            { width: `${fwd1}%` },
            { width: `${back2}%` },
            { width: `${fwd2}%` },
            { width: `${pct}%` },
          ],
          { duration: 750, easing: 'ease', fill: 'forwards' },
        );
      }

      this.stabilityJitterAnim.onfinish = () => {
        this.stabilityBarFillEl?.classList.remove('is-surprise');
        this.stabilityBarFillEl?.setCssProps({ '--stability-width': `${pct}%` });
        this.stabilityJitterAnim = undefined;
      };
    } else {
      this.stabilityBarFillEl.setCssProps({ '--stability-width': `${pct}%` });
    }
  }

  private getCohortSyncScrollEnabled(): boolean {
    const def = this.plugin.dataStore.getCohortDef(this.cohortKey);
    return def?.syncScroll ?? true;
  }

  private flashPressed(btn?: HTMLButtonElement, durationMs = 110): void {
    if (!btn) return;

    const win = btn.ownerDocument.defaultView ?? window;

    btn.classList.add('glicko-pressed');

    const existing = this.pressTimers.get(btn);
    if (typeof existing === 'number') win.clearTimeout(existing);

    const tid = win.setTimeout(() => btn.classList.remove('glicko-pressed'), durationMs);

    this.pressTimers.set(btn, tid);
  }

  private getVisibleSide(): 'left' | 'right' | undefined {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    if (active === this.leftLeaf) {
      this.lastVisibleSide = 'left';
      return 'left';
    }
    if (active === this.rightLeaf) {
      this.lastVisibleSide = 'right';
      return 'right';
    }
    return undefined;
  }

  private switchNote(): void {
    const side = this.getVisibleSide() ?? this.lastVisibleSide;
    const target = side === 'left' ? this.rightLeaf : this.leftLeaf;

    this.app.workspace.setActiveLeaf(target, { focus: true });
    this.lastVisibleSide = side === 'left' ? 'right' : 'left';
    this.updateOverlay();
  }

  private chooseCurrentWinner(): void {
    const side = this.getVisibleSide();
    if (!side) {
      this.showToast('Tap Switch to view a note, then choose a winner.');
      return;
    }
    void this.choose(side === 'left' ? 'A' : 'B');
  }

  private mountOverlay(doc: Document = document) {
    const el = doc.body.createDiv({ cls: 'glicko-session-bar' });
    if (Platform.isPhone) el.classList.add('is-mobile');

    el.createDiv({ cls: 'glicko-side left' });

    if (Platform.isPhone) {
      this.mobileTitleEl = el.createDiv({ cls: 'glicko-mobile-title' });
    }

    const controls = el.createDiv({ cls: 'glicko-controls' });

    if (Platform.isPhone) {
      this.drawBtn = this.makeButton(doc, 'Draw', () => void this.choose('D'));
      this.winBtn = this.makeButton(doc, 'Win ✓', () => this.chooseCurrentWinner());
      this.switchBtn = this.makeButton(doc, '⇄ Switch', () => this.switchNote());

      this.undoBtn = this.makeButton(doc, 'Undo ⌫', () => void this.undo());
      this.endBtn = this.makeButton(doc, 'End Esc', () => void this.plugin.endSession());

      controls.append(this.drawBtn, this.winBtn, this.switchBtn, this.undoBtn, this.endBtn);
    } else {
      this.leftBtn = this.makeButton(doc, '← Left', () => void this.choose('A'));
      this.drawBtn = this.makeButton(doc, '↑ Draw', () => void this.choose('D'));
      this.rightBtn = this.makeButton(doc, '→ Right', () => void this.choose('B'));
      this.undoBtn = this.makeButton(doc, 'Undo ⌫', () => void this.undo());
      this.endBtn = this.makeButton(doc, 'End Esc', () => void this.plugin.endSession());

      controls.append(this.leftBtn, this.drawBtn, this.rightBtn, this.undoBtn, this.endBtn);
    }

    el.createDiv({ cls: 'glicko-side right' });

    // Stability progress bar
    const track = el.createDiv({ cls: 'glicko-stability-track' });
    this.stabilityBarFillEl = track.createDiv({ cls: 'glicko-stability-fill' });

    this.overlayEl = el;
    this.updateOverlay();
  }

  private unmountOverlay() {
    if (this.overlayEl?.isConnected) this.overlayEl.remove();
    this.overlayEl = undefined;

    this.switchBtn = undefined;
    this.winBtn = undefined;
    this.mobileTitleEl = undefined;

    this.stabilityBarFillEl = undefined;

    this.leftBtn = undefined;
    this.drawBtn = undefined;
    this.rightBtn = undefined;
    this.undoBtn = undefined;
    this.endBtn = undefined;
  }

  private makeButton(doc: Document, text: string, onClick: () => void) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }

  private updateOverlay() {
    if (!this.overlayEl) return;

    const left = this.overlayEl.querySelector('.glicko-side.left') as HTMLElement;
    const right = this.overlayEl.querySelector('.glicko-side.right') as HTMLElement;
    left.textContent = this.leftFile?.basename ?? 'Left';
    right.textContent = this.rightFile?.basename ?? 'Right';

    if (!Platform.isPhone) return;

    const visible = this.getVisibleSide();

    const curFile =
      visible === 'left' ? this.leftFile : visible === 'right' ? this.rightFile : undefined;

    const title = curFile
      ? `${visible === 'left' ? 'Left' : 'Right'}: ${curFile.basename}`
      : `${this.leftFile?.basename ?? 'Left'} vs ${this.rightFile?.basename ?? 'Right'}`;

    if (this.mobileTitleEl) this.mobileTitleEl.textContent = title;
  }

  private isArenaShortcutKey(ev: KeyboardEvent): boolean {
    return (
      ev.key === 'ArrowLeft' ||
      ev.key === 'ArrowRight' ||
      ev.key === 'ArrowUp' ||
      ev.key === 'ArrowDown' ||
      ev.key === 'Backspace' ||
      ev.key === 'Escape'
    );
  }

  private showShortcutsPausedToast(ev: KeyboardEvent): void {
    if (!this.isArenaShortcutKey(ev)) return;
    if (this.shortcutsPausedToastShown === true) return;

    this.shortcutsPausedToastShown = true;
    this.showToast('Glicko keyboard shortcuts are paused while editing.');
  }

  private onKeydown(ev: KeyboardEvent) {
    // Ignore when typing in inputs/editors
    const target = ev.target as HTMLElement | null;
    const doc = target?.ownerDocument ?? this.overlayEl?.ownerDocument ?? document;

    const activeEl = doc.activeElement as HTMLElement | null;

    const isTextEntryEl = (el: HTMLElement | null): boolean => {
      if (!el) return false;

      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return true;

      // Any contenteditable region should also suppress shortcuts.
      if (el.isContentEditable) return true;

      if (el.closest('.cm-editor')) return true;

      return false;
    };

    const isAnyCmFocused = !!activeEl?.closest('.cm-editor');

    const blockedByEditing = isTextEntryEl(target) || isTextEntryEl(activeEl) || isAnyCmFocused;
    if (blockedByEditing) {
      this.showShortcutsPausedToast(ev);
      return;
    }
    this.shortcutsPausedToastShown = false;

    // Ignore auto-repeat for voting keys (prevents accidental multi-votes if a key is held).
    if (
      ev.repeat &&
      (ev.key === 'ArrowLeft' ||
        ev.key === 'ArrowRight' ||
        ev.key === 'ArrowUp' ||
        ev.key === 'ArrowDown' ||
        ev.key === 'Backspace')
    ) {
      ev.preventDefault();
      return;
    }

    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      this.flashPressed(this.leftBtn);
      void this.choose('A');
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      this.flashPressed(this.rightBtn);
      void this.choose('B');
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.flashPressed(this.drawBtn);
      void this.choose('D');
    } else if (ev.key === 'Backspace') {
      ev.preventDefault();
      this.flashPressed(this.undoBtn);
      void this.undo();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.flashPressed(this.endBtn);
      void this.plugin.endSession();
    }
  }

  private showToast(message: string, timeout = 4000): void {
    this.liveNotices.push(new Notice(message, timeout));
  }

  private getEffectiveFrontmatter(): FrontmatterPropertiesSettings {
    const def = this.plugin.dataStore.getCohortDef(this.cohortKey);
    return effectiveFrontmatterProperties(
      this.plugin.settings.frontmatterProperties,
      def?.frontmatterOverrides,
    );
  }

  private async choose(result: MatchResult) {
    if (!this.leftFile || !this.rightFile) return;

    const [aId, bId] = await Promise.all([
      this.getIdForFile(this.leftFile),
      this.getIdForFile(this.rightFile),
    ]);

    const { undo } = this.plugin.dataStore.applyMatch(this.cohortKey, aId, bId, result);
    this.undoStack.push(undo);

    const surprise = this.computeSurpriseForFrame(undo);
    this.updateStabilityBar(surprise);

    if (this.plugin.settings.showToasts) {
      if (result === 'A') this.showToast(`Winner: ${this.leftFile.basename}`);
      else if (result === 'B') this.showToast(`Winner: ${this.rightFile.basename}`);
      else this.showToast('Draw');
    }
    void this.plugin.dataStore.saveStore();

    // Write frontmatter stats to both notes
    const cohort = this.plugin.dataStore.store.cohorts[this.cohortKey];
    const fm = this.getEffectiveFrontmatter();
    void writeFrontmatterStatsForPair(
      this.app,
      fm,
      cohort,
      this.leftFile,
      aId,
      this.rightFile,
      bId,
    );

    this.pickNextPair();
    await this.openCurrent();
    this.updateOverlay();
  }

  private async getIdForFile(file: TFile): Promise<string> {
    const cached = this.idByPath.get(file.path);
    if (cached) return cached;

    const propName = this.plugin.settings.idPropertyName;
    const existing = await getNoteId(this.app, file, propName);
    if (existing) {
      this.idByPath.set(file.path, existing);
      return existing;
    }

    const id = await ensureNoteId(
      this.app,
      file,
      this.plugin.settings.idLocation ?? 'frontmatter',
      propName,
    );
    this.idByPath.set(file.path, id);
    return id;
  }

  private async undo() {
    const frame = this.undoStack.pop();
    if (!frame) {
      this.showToast('Nothing to undo.');
      return;
    }

    if (this.plugin.dataStore.revert(frame)) this.showToast('Undid last match.');
    void this.plugin.dataStore.saveStore();

    this.updateStabilityBar();

    // Update the two notes involved in the undone match, if we can find them
    const aFile = this.findFileById(frame.a.id);
    const bFile = this.findFileById(frame.b.id);
    const cohort = this.plugin.dataStore.store.cohorts[frame.cohortKey];
    const fm = this.getEffectiveFrontmatter();
    void writeFrontmatterStatsForPair(this.app, fm, cohort, aFile, frame.a.id, bFile, frame.b.id);

    // Restore the undone pair so the user can re-evaluate
    if (aFile && bFile) {
      this.leftFile = aFile;
      this.rightFile = bFile;
      this.lastPair = [aFile.path, bFile.path].sort() as [string, string];
      await this.openCurrent();
      this.updateOverlay();
    }
  }

  private findFileById(id: string): TFile | undefined {
    for (const [path, knownId] of this.idByPath) {
      if (knownId === id) {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (af instanceof TFile) return af;
      }
    }
    return undefined;
  }

  // ---- Matchmaking helpers ----

  private getStatsForFile(file: TFile): { rating: number; sigma: number } {
    const id = this.idByPath.get(file.path);
    const cohort = this.plugin.dataStore.store.cohorts[this.cohortKey];

    if (id && cohort) {
      const p = cohort.players[id];
      if (p) return { rating: p.rating, sigma: p.sigma };
    }

    return { rating: 1500, sigma: DEFAULT_SIGMA };
  }

  private pickNextPair() {
    if (this.files.length < 2) {
      this.leftFile = this.rightFile = undefined;
      return;
    }

    const { leftIndex, rightIndex } = pickNextPairIndices(
      this.files,
      (f) => this.getStatsForFile(f),
      this.lastPair,
    );

    if (leftIndex < 0 || rightIndex < 0) {
      this.leftFile = this.rightFile = undefined;
      return;
    }

    this.leftFile = this.files[leftIndex];
    this.rightFile = this.files[rightIndex];
    this.lastPair = [this.leftFile.path, this.rightFile.path].sort() as [string, string];
  }
}
