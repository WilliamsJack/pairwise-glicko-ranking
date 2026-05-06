import type { App } from 'obsidian';
import { Notice, PluginSettingTab, setIcon, Setting } from 'obsidian';

import { prettyCohortDefinition, resolveFilesForCohort } from '../domain/cohort/CohortResolver';
import type GlickoPlugin from '../main';
import type { CohortData } from '../types';
import { CohortOptionsModal } from '../ui/CohortOptionsModal';
import { ConfirmModal } from '../ui/ConfirmModal';
import { FolderSelectModal } from '../ui/FolderPicker';
import { FM_PROP_KEYS, renderStandardFmPropertyRow } from '../ui/FrontmatterPropertyRow';
import {
  computeRanksForAll,
  previewCohortFrontmatterPropertyUpdates,
  updateCohortFrontmatter,
} from '../utils/FrontmatterStats';
import { applyIdTransferPlan, planIdTransfer } from '../utils/IdTransfer';
import { withNotice } from '../utils/safe';
import type { IdLocation } from './settings';
import type { FrontmatterPropertiesSettings, SessionLayoutMode } from './settings';
import { DEFAULT_SETTINGS, effectiveFrontmatterProperties } from './settings';
import { migrateIdPropertyName } from './SettingsTabMigration';

type PropKey = keyof FrontmatterPropertiesSettings;

export default class GlickoSettingsTab extends PluginSettingTab {
  icon = 'trophy';
  plugin: GlickoPlugin;

  constructor(app: App, plugin: GlickoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // General
    new Setting(containerEl)
      .setName('Show win/draw notices')
      .setDesc(
        `Show a toast with the winner after each comparison. Default: ${DEFAULT_SETTINGS.showToasts ? 'On' : 'Off'}.`,
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showToasts).onChange(async (v) => {
          this.plugin.settings.showToasts = v;
          await this.plugin.saveSettings();
        }),
      );

    // Session layout
    const layoutLabels: Record<SessionLayoutMode, string> = {
      'reuse-active': 'Reuse active pane',
      'right-split': 'Insert to the right of active pane',
      'new-tab': 'New tab',
      'new-window': 'New window (pop-out)',
    };
    new Setting(containerEl)
      .setName('Session layout')
      .setDesc('Choose how and where the arena opens.')
      .addDropdown((dd) => {
        dd.addOptions(layoutLabels)
          .setValue(this.plugin.settings.sessionLayout ?? DEFAULT_SETTINGS.sessionLayout)
          .onChange(async (v) => {
            const val: SessionLayoutMode =
              v === 'reuse-active' || v === 'right-split' || v === 'new-tab' || v === 'new-window'
                ? v
                : 'new-tab';
            this.plugin.settings.sessionLayout = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Note ID location')
      .setDesc(
        `Where to store the note ID. When you change this setting, you can optionally move existing IDs to the new location.
        If you choose not to move them, IDs left in the old location will continue to work.
        The frontmatter ID is always used if it exists.`,
      )
      .addDropdown((dd) => {
        dd.addOptions({
          frontmatter: 'Frontmatter (YAML)',
          end: 'End of note (HTML comment)',
        })
          .setValue(this.plugin.settings.idLocation ?? 'frontmatter')
          .onChange(async (v) => {
            const oldLoc: IdLocation = this.plugin.settings.idLocation ?? 'frontmatter';
            const newLoc: IdLocation = v === 'end' ? 'end' : 'frontmatter';
            if (newLoc === oldLoc) return;

            this.plugin.settings.idLocation = newLoc;
            await this.plugin.saveSettings();

            const files = this.app.vault.getMarkdownFiles();
            if (files.length === 0) return;

            const propName = this.plugin.settings.idPropertyName;
            let plan;
            try {
              plan = await withNotice('Scanning notes for note IDs...', () =>
                planIdTransfer(
                  this.app,
                  files,
                  { propertyName: propName, location: oldLoc },
                  { propertyName: propName, location: newLoc },
                ),
              );
            } catch (e) {
              console.error('[Glicko] Failed to plan note ID transfer', e);
              new Notice('Failed to scan notes for note IDs.');
              return;
            }

            if (plan.wouldUpdate === 0) return;

            const locLabel = (loc: IdLocation) =>
              loc === 'frontmatter' ? 'frontmatter' : 'end-of-note HTML comment';

            const msg =
              `Move note IDs from ${locLabel(oldLoc)} to ${locLabel(newLoc)} for ${plan.wouldUpdate} note${plan.wouldUpdate === 1 ? '' : 's'}?` +
              (plan.mismatches > 0
                ? `\n\n${plan.mismatches} note${plan.mismatches === 1 ? ' has' : 's have'} differing IDs in frontmatter and the end-of-note HTML comment.
                The ID in the end-of-note HTML comment will be removed, and the frontmatter ID will be ${newLoc === 'frontmatter' ? 'kept' : 'moved to the end-of-note HTML comment'}.`
                : '');

            const ok = await new ConfirmModal(
              this.app,
              'Move note IDs?',
              msg,
              'Yes, move',
              'No, leave as-is',
            ).openAndConfirm();

            if (!ok) return;

            const res = await applyIdTransferPlan(this.app, plan, {
              noticeMessage: 'Moving note IDs...',
            });

            new Notice(
              `Moved note IDs in ${res.updated} note${res.updated === 1 ? '' : 's'}` +
                (res.mismatches > 0
                  ? ` (${res.mismatches} mismatch${res.mismatches === 1 ? '' : 'es'} resolved).`
                  : '.'),
            );
          });
      });

    // Note ID property name
    new Setting(containerEl)
      .setName('Note ID property name')
      .setDesc(
        'The frontmatter property (or HTML comment tag) used to store note IDs. Changing this will offer to migrate all existing notes.',
      )
      .addText((t) => {
        t.setValue(this.plugin.settings.idPropertyName).setPlaceholder(
          DEFAULT_SETTINGS.idPropertyName,
        );

        // Trigger migration on blur (not on every keystroke)
        t.inputEl.addEventListener('blur', async () => {
          const trimmed = (t.getValue() ?? '').trim();
          if (!trimmed || trimmed === this.plugin.settings.idPropertyName) return;

          await migrateIdPropertyName(this.app, this.plugin, trimmed);
          this.display();
        });
      });

    // Progress bar
    new Setting(containerEl).setName('Progress bar').setHeading();

    new Setting(containerEl)
      .setName('Highlight surprising results')
      .setDesc(
        `Wobble the progress bar when a match result is unexpected, alterting you that your choice was unexpected. Default: ${DEFAULT_SETTINGS.surpriseJitter ? 'On' : 'Off'}.`,
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.surpriseJitter ?? DEFAULT_SETTINGS.surpriseJitter)
          .onChange(async (v) => {
            this.plugin.settings.surpriseJitter = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Stability threshold')
      .setDesc(
        `Uncertainty value at which the progress bar reaches 100%. Lower values require more matches. Default: ${DEFAULT_SETTINGS.stabilityThreshold}.`,
      )
      .addSlider((sl) => {
        const current =
          this.plugin.settings.stabilityThreshold ?? DEFAULT_SETTINGS.stabilityThreshold;
        sl.setLimits(80, 250, 10)
          .setValue(Math.max(80, Math.min(250, current)))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.stabilityThreshold = Math.round(value);
            await this.plugin.saveSettings();
          });
      });

    // Cohort configuration
    new Setting(containerEl).setName('Cohorts').setHeading();

    new Setting(containerEl)
      .setName('Templates folder')
      .setDesc(
        'Excludes your templates from cohorts. Prevents note IDs from appearing on templates.',
      )
      .addText((t) => {
        t.setPlaceholder('Templates')
          .setValue(this.plugin.settings.templatesFolderPath ?? '')
          .onChange(async (v) => {
            this.plugin.settings.templatesFolderPath = (v ?? '').trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((b) =>
        b.setButtonText('Browse...').onClick(async () => {
          const folder = await new FolderSelectModal(this.app).openAndGetSelection();
          if (!folder) return;

          // Disallow vault root as a "templates folder" (treat as disabled)
          const picked = (folder.path ?? '').trim();
          this.plugin.settings.templatesFolderPath = picked.length > 0 ? picked : '';
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText('Clear').onClick(async () => {
          this.plugin.settings.templatesFolderPath = '';
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    containerEl.createEl('p', {
      text: "Configure existing cohorts' frontmatter properties or delete a cohort.",
    });

    const defs = this.plugin.dataStore.listCohortDefs();
    if (defs.length === 0) {
      containerEl.createDiv({
        cls: 'glicko-muted',
        text: 'No cohorts saved yet. Start a session to create one, or use the Command palette.',
      });
    } else {
      const list = containerEl.createDiv({ cls: 'installed-plugins-container' });

      // Sort by display label
      const sorted = defs.slice().sort((a, b) => {
        const an = (a.label ?? prettyCohortDefinition(a)).toLowerCase();
        const bn = (b.label ?? prettyCohortDefinition(b)).toLowerCase();
        return an.localeCompare(bn);
      });

      for (const def of sorted) {
        const row = list.createDiv({ cls: 'setting-item mod-toggle' });

        const info = row.createDiv({ cls: 'glicko-cohort-item-info' });
        info.addEventListener('click', () => {
          void this.configureCohort(def.key);
        });

        const name = info.createDiv({
          cls: 'setting-item-name',
          text: def.label ?? prettyCohortDefinition(def),
        });
        name.title = def.key;

        const desc = info.createDiv({ cls: 'setting-item-description' });
        desc.createDiv({ text: `Definition: ${prettyCohortDefinition(def)}` });

        const controls = row.createDiv({ cls: 'setting-item-control' });

        const settingsBtn = controls.createDiv({
          cls: 'clickable-icon extra-setting-button',
          attr: { 'aria-label': 'Configure cohort' },
        });
        setIcon(settingsBtn, 'settings');
        settingsBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.configureCohort(def.key);
        });

        const deleteBtn = controls.createDiv({
          cls: 'clickable-icon extra-setting-button',
          attr: { 'aria-label': 'Delete cohort' },
        });
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.deleteCohortWithConfirm(def.key);
        });
      }
    }

    // Cohort defaults section
    new Setting(containerEl).setName('Cohort defaults').setHeading();

    const fmAcc = containerEl.createEl('details', { cls: 'glicko-settings-accordion' });
    fmAcc.open = false;
    fmAcc.createEl('summary', { text: 'Default frontmatter properties' });
    const fmBody = fmAcc.createDiv({ cls: 'glicko-settings-body' });

    const fm = this.plugin.settings.frontmatterProperties;

    new Setting(fmBody)
      .setName('Ask for per-cohort overrides on creation')
      .setDesc(
        `When creating a cohort, prompt to set frontmatter overrides. Turn off to always use the global defaults. Default: ${DEFAULT_SETTINGS.askForOverridesOnCohortCreation ? 'On' : 'Off'}.`,
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.askForOverridesOnCohortCreation).onChange(async (v) => {
          this.plugin.settings.askForOverridesOnCohortCreation = v;
          await this.plugin.saveSettings();
        }),
      );

    fmBody.createEl('p', {
      text:
        "Choose which Glicko statistics to write into a note's frontmatter and the property names to use. " +
        'These are global defaults; cohort-specific overrides can be applied during creation.',
    });

    for (const key of FM_PROP_KEYS) {
      const cfg = fm[key];
      renderStandardFmPropertyRow(fmBody, key, {
        value: { enabled: cfg.enabled, property: cfg.property },
        base: { enabled: cfg.enabled, property: cfg.property },
        mode: 'global',
        onChange: async (next) => {
          cfg.enabled = !!next.enabled;
          cfg.property = next.property;
          await this.plugin.saveSettings();
        },
      });
    }

    // Default post-session report settings accordion
    const reportAcc = containerEl.createEl('details', { cls: 'glicko-settings-accordion' });
    reportAcc.open = false;
    reportAcc.createEl('summary', { text: 'Default post-session report settings' });
    const reportBody = reportAcc.createDiv({ cls: 'glicko-settings-body' });

    reportBody.createEl('p', {
      text: 'These settings are used as defaults when configuring reports on a new cohort.',
    });

    new Setting(reportBody)
      .setName('Ask for report settings on creation')
      .setDesc(
        `When creating a cohort, prompt to configure report settings. Turn off to always use the defaults below. Default: ${DEFAULT_SETTINGS.askForReportSettingsOnCreation ? 'On' : 'Off'}.`,
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.askForReportSettingsOnCreation).onChange(async (v) => {
          this.plugin.settings.askForReportSettingsOnCreation = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(reportBody)
      .setName('Enable reports by default')
      .setDesc('Generate a post-session report for new cohorts by default.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sessionReport.enabled).onChange(async (v) => {
          this.plugin.settings.sessionReport.enabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(reportBody)
      .setName('Default report folder')
      .setDesc('Pre-filled vault-relative folder for session reports.')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.sessionReport.folderPath)
          .setValue(this.plugin.settings.sessionReport.folderPath)
          .onChange(async (v) => {
            this.plugin.settings.sessionReport.folderPath = (v ?? '').trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(reportBody)
      .setName('Default report name')
      .setDesc('Available: {{cohort}}, {{date}}, {{datetime}}, {{count}}')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.sessionReport.nameTemplate)
          .setValue(this.plugin.settings.sessionReport.nameTemplate)
          .onChange(async (v) => {
            this.plugin.settings.sessionReport.nameTemplate =
              (v ?? '').trim() || DEFAULT_SETTINGS.sessionReport.nameTemplate;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(reportBody)
      .setName('Default report template')
      .setDesc(
        'Vault path to a markdown file with {{glicko:...}} placeholders. Leave blank to use the built-in template.',
      )
      .addText((t) =>
        t
          .setPlaceholder('e.g. Templates/My Report.md')
          .setValue(this.plugin.settings.sessionReport.reportTemplatePath ?? '')
          .onChange(async (v) => {
            this.plugin.settings.sessionReport.reportTemplatePath = (v ?? '').trim() || undefined;
            await this.plugin.saveSettings();
          }),
      )
      .addButton((b) =>
        b.setButtonText('Generate template').onClick(async () => {
          try {
            const { generateOrOverwriteExampleTemplate } =
              await import('../domain/report/generateExampleTemplate');
            const file = await generateOrOverwriteExampleTemplate(this.app, {
              filePath: this.plugin.settings.sessionReport.reportTemplatePath,
              templatesFolderPath:
                this.plugin.settings.templatesFolderPath ||
                this.plugin.settings.sessionReport.folderPath ||
                '',
            });
            if (!file) return;

            this.plugin.settings.sessionReport.reportTemplatePath = file.path;
            await this.plugin.saveSettings();
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file);
            this.display();
            new Notice('Report template created and set as default.');
          } catch (e) {
            console.error('[Glicko] Failed to generate example template', e);
            new Notice('Failed to generate example template.');
          }
        }),
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc(
        'Log detailed debug information to the developer console. Useful for troubleshooting.',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugLogging).onChange(async (v) => {
          this.plugin.settings.debugLogging = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private async deleteCohortWithConfirm(cohortKey: string): Promise<void> {
    const def = this.plugin.dataStore.getCohortDef(cohortKey);
    const label = def ? (def.label ?? prettyCohortDefinition(def)) : 'Cohort';

    const ok = await new ConfirmModal(
      this.app,
      'Delete cohort?',
      `Are you sure you want to delete "${label}"? This removes the cohort and its saved ratings. Your notes will not be modified.`,
      'Delete',
      'Cancel',
      true,
    ).openAndConfirm();
    if (!ok) return;

    // Remove data and definition
    const store = this.plugin.dataStore.store;
    if (store.cohorts && store.cohorts[cohortKey]) delete store.cohorts[cohortKey];
    if (store.cohortDefs && store.cohortDefs[cohortKey]) delete store.cohortDefs[cohortKey];
    if (store.lastUsedCohortKey === cohortKey) store.lastUsedCohortKey = undefined;
    await this.plugin.dataStore.saveStore();

    new Notice(`Deleted cohort: ${label}`);
    this.display();
  }

  private async configureCohort(cohortKey: string): Promise<void> {
    const def = this.plugin.dataStore.getCohortDef(cohortKey);
    if (!def) return;

    const res = await new CohortOptionsModal(this.app, this.plugin, {
      mode: 'edit',
      initial: def.frontmatterOverrides,
      initialName: def.label ?? '',
      initialScrollStart: def.scrollStart,
      initialSyncScroll: def.syncScroll ?? true,
      initialSessionReport: def.sessionReport,
    }).openAndGetOptions();

    if (!res) return;

    const overrides = res.overrides ?? {};

    // Compute old vs new effective config, then save new overrides and name
    const base = this.plugin.settings.frontmatterProperties;
    const oldEffective = effectiveFrontmatterProperties(base, def.frontmatterOverrides);
    const newEffective = effectiveFrontmatterProperties(base, overrides);

    // Persist properties overrides (clear if no keys), label, and initial scroll
    const hasKeys = Object.keys(overrides).length > 0;
    def.frontmatterOverrides = hasKeys ? overrides : undefined;

    const newName = (res.name ?? '').trim();
    def.label = newName.length > 0 ? newName : undefined;

    def.scrollStart = res.scrollStart && res.scrollStart !== 'none' ? res.scrollStart : undefined;

    def.syncScroll = res.syncScroll ?? true;

    if (res.sessionReport) {
      def.sessionReport = res.sessionReport;
    }

    this.plugin.dataStore.upsertCohortDef(def);
    await this.plugin.dataStore.saveStore();
    this.display();

    // Determine changes that require optional bulk updates
    const changed: Array<{
      key: PropKey;
      action: 'rename' | 'remove' | 'upsert';
      oldProp?: string;
      newProp?: string;
    }> = [];

    const keys: PropKey[] = ['rating', 'uncertainty', 'rank', 'matches', 'wins'];
    for (const key of keys) {
      const oldCfg = oldEffective[key];
      const newCfg = newEffective[key];

      if (oldCfg.enabled && !newCfg.enabled) {
        changed.push({ key, action: 'remove', oldProp: oldCfg.property });
        continue;
      }
      if (newCfg.enabled && oldCfg.enabled && oldCfg.property !== newCfg.property) {
        changed.push({ key, action: 'rename', oldProp: oldCfg.property, newProp: newCfg.property });
        continue;
      }
      if (!oldCfg.enabled && newCfg.enabled) {
        changed.push({ key, action: 'upsert', newProp: newCfg.property });
        continue;
      }
    }

    if (changed.length === 0) return;

    const files = await resolveFilesForCohort(this.app, def, {
      excludeFolderPath: this.plugin.settings.templatesFolderPath,
    });
    if (files.length === 0) return;

    const idPropName = this.plugin.settings.idPropertyName;
    const cohort: CohortData | undefined = this.plugin.dataStore.store.cohorts[cohortKey];
    const valuesFor = (key: PropKey): Map<string, number> => {
      const map = new Map<string, number>();
      if (!cohort) return map;
      if (key === 'rank') {
        const rankMap = computeRanksForAll(cohort);
        for (const [id, rank] of rankMap) map.set(id, rank);
      } else if (key === 'rating') {
        for (const [id, p] of Object.entries(cohort.players)) map.set(id, Math.round(p.rating));
      } else if (key === 'uncertainty') {
        for (const [id, p] of Object.entries(cohort.players)) map.set(id, Math.round(p.sigma));
      } else if (key === 'matches') {
        for (const [id, p] of Object.entries(cohort.players)) map.set(id, p.matches);
      } else if (key === 'wins') {
        for (const [id, p] of Object.entries(cohort.players)) map.set(id, p.wins);
      }
      return map;
    };

    // Run prompts sequentially
    for (const change of changed) {
      const key = change.key;
      const vals = valuesFor(key);

      if (change.action === 'remove' && change.oldProp) {
        const preview = await previewCohortFrontmatterPropertyUpdates(
          this.app,
          files,
          new Map(),
          '',
          change.oldProp,
          idPropName,
        );
        if (preview.wouldUpdate === 0) continue;

        const ok = await new ConfirmModal(
          this.app,
          'Remove cohort property?',
          `Remove frontmatter property "${change.oldProp}" from ${preview.wouldUpdate} notes in this cohort?`,
          'Yes, remove',
          "No, don't update",
        ).openAndConfirm();
        if (!ok) continue;

        const res = await updateCohortFrontmatter(
          this.app,
          files,
          new Map(),
          '',
          change.oldProp,
          `Removing "${change.oldProp}" from ${preview.wouldUpdate} notes...`,
          idPropName,
        );
        new Notice(`Removed "${change.oldProp}" from ${res.updated} notes.`);
      } else if (change.action === 'rename' && change.oldProp && change.newProp) {
        const preview = await previewCohortFrontmatterPropertyUpdates(
          this.app,
          files,
          vals,
          change.newProp,
          change.oldProp,
          idPropName,
        );
        if (preview.wouldUpdate === 0) continue;

        const ok = await new ConfirmModal(
          this.app,
          'Rename cohort property?',
          `Rename frontmatter property "${change.oldProp}" to "${change.newProp}" on ${preview.wouldUpdate} notes in this cohort?`,
          'Yes, rename',
          "No, don't rename",
        ).openAndConfirm();
        if (!ok) continue;

        const res = await updateCohortFrontmatter(
          this.app,
          files,
          vals,
          change.newProp,
          change.oldProp,
          `Renaming "${change.oldProp}" to "${change.newProp}" on ${preview.wouldUpdate} notes...`,
          idPropName,
        );
        new Notice(`Updated ${res.updated} notes.`);
      } else if (change.action === 'upsert' && change.newProp) {
        const preview = await previewCohortFrontmatterPropertyUpdates(
          this.app,
          files,
          vals,
          change.newProp,
          undefined,
          idPropName,
        );
        if (preview.wouldUpdate === 0) continue;

        const ok = await new ConfirmModal(
          this.app,
          'Write cohort property?',
          `Write frontmatter property "${change.newProp}" to ${preview.wouldUpdate} notes in this cohort?`,
          'Yes, write',
          "No, don't write",
        ).openAndConfirm();
        if (!ok) continue;

        const res = await updateCohortFrontmatter(
          this.app,
          files,
          vals,
          change.newProp,
          undefined,
          `Writing "${change.newProp}" to ${preview.wouldUpdate} notes...`,
          idPropName,
        );
        new Notice(`Wrote "${change.newProp}" on ${res.updated} notes.`);
      }
    }
  }
}
