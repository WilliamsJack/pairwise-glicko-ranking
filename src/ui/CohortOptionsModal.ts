import type { App, TextComponent } from 'obsidian';
import { Setting } from 'obsidian';

import type GlickoPlugin from '../main';
import type {
  FrontmatterPropertiesSettings,
  FrontmatterPropertyConfig,
  SessionReportConfig,
} from '../settings';
import { DEFAULT_SETTINGS } from '../settings';
import type { ScrollStartMode } from '../types';
import { FM_PROP_KEYS, renderStandardFmPropertyRow } from './FrontmatterPropertyRow';
import { BasePromiseModal } from './PromiseModal';

type Mode = 'create' | 'edit';

type Key = keyof FrontmatterPropertiesSettings;

type RowState = {
  key: Key;
  enabled: boolean;
  property: string;
  overridden: boolean;
};

export type CohortOptionsResult = {
  overrides: Partial<FrontmatterPropertiesSettings>;
  name?: string;
  scrollStart?: ScrollStartMode;
  syncScroll?: boolean;
  sessionReport?: SessionReportConfig;
};

export class CohortOptionsModal extends BasePromiseModal<CohortOptionsResult | undefined> {
  private plugin: GlickoPlugin;

  private mode: Mode;
  private base: FrontmatterPropertiesSettings;
  private initial?: Partial<FrontmatterPropertiesSettings>;
  private initialName?: string;
  private initialScrollStart?: ScrollStartMode;
  private initialSyncScroll?: boolean;
  private initialSessionReport?: SessionReportConfig;
  private showFrontmatterSettings: boolean;
  private showReportSettings: boolean;

  private nameWorking = '';
  private scrollWorking: ScrollStartMode = 'none';
  private syncScrollWorking = true;

  private reportEnabled = DEFAULT_SETTINGS.sessionReport.enabled;
  private reportFolderPath = DEFAULT_SETTINGS.sessionReport.folderPath;
  private reportNameTemplate = DEFAULT_SETTINGS.sessionReport.nameTemplate;
  private reportTemplatePath = '';

  private working: Record<Key, RowState>;

  constructor(
    app: App,
    plugin: GlickoPlugin,
    opts?: {
      mode?: Mode;
      initial?: Partial<FrontmatterPropertiesSettings>;
      initialName?: string;
      initialScrollStart?: ScrollStartMode;
      initialSyncScroll?: boolean;
      initialSessionReport?: SessionReportConfig;
      showFrontmatterSettings?: boolean;
      showReportSettings?: boolean;
    },
  ) {
    super(app);
    this.plugin = plugin;
    this.mode = opts?.mode ?? 'create';
    this.base = plugin.settings.frontmatterProperties;
    this.initial = opts?.initial;
    this.initialName = (opts?.initialName ?? '').trim();
    this.nameWorking = this.initialName ?? '';

    this.initialScrollStart = opts?.initialScrollStart;
    this.scrollWorking = this.initialScrollStart ?? 'none';

    this.initialSyncScroll = opts?.initialSyncScroll;
    this.syncScrollWorking = this.initialSyncScroll ?? true;

    this.initialSessionReport = opts?.initialSessionReport;
    this.showFrontmatterSettings = opts?.showFrontmatterSettings ?? true;
    this.showReportSettings = opts?.showReportSettings ?? true;
    const reportDefaults = opts?.initialSessionReport ?? plugin.settings.sessionReport;
    this.reportEnabled = reportDefaults.enabled;
    this.reportFolderPath = reportDefaults.folderPath;
    this.reportNameTemplate = reportDefaults.nameTemplate;
    this.reportTemplatePath = reportDefaults.reportTemplatePath ?? '';

    const mk = (k: Key): RowState => {
      const baseCfg = this.base[k];
      const ovCfg = this.initial?.[k];
      const chosen: FrontmatterPropertyConfig = ovCfg ?? baseCfg;
      return {
        key: k,
        enabled: chosen.enabled,
        property: chosen.property,
        overridden: !!ovCfg, // overridden only if present in initial overrides
      };
    };

    this.working = {
      rating: mk('rating'),
      uncertainty: mk('uncertainty'),
      rank: mk('rank'),
      matches: mk('matches'),
      wins: mk('wins'),
    };
  }

  async openAndGetOptions(): Promise<CohortOptionsResult | undefined> {
    return this.openAndGetValue();
  }

  private updateOverriddenFlag(row: RowState) {
    const baseCfg = this.base[row.key];
    row.overridden = row.enabled !== baseCfg.enabled || row.property !== baseCfg.property;
  }

  private buildOverridesPayload(): Partial<FrontmatterPropertiesSettings> {
    const out: Partial<FrontmatterPropertiesSettings> = {};
    for (const key of Object.keys(this.working) as Key[]) {
      const row = this.working[key];
      this.updateOverriddenFlag(row);
      if (row.overridden) {
        out[key] = { property: row.property.trim(), enabled: !!row.enabled };
      }
    }
    return out;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const desc =
      this.mode === 'create'
        ? 'Set an optional name and configure which Glicko statistics to write into frontmatter for this cohort. Global defaults are prefilled.'
        : 'Rename the cohort and adjust which Glicko statistics to write into frontmatter. Use Reset to revert a property to the global default.';

    contentEl.createEl('h3', { text: 'Cohort options' });
    contentEl.createEl('p', { text: desc });

    new Setting(contentEl)
      .setName('Cohort name')
      .setDesc('Shown in menus. Optional - leave blank to use an automatic description.')
      .addText((t) =>
        t
          .setPlaceholder('My reading list')
          .setValue(this.nameWorking)
          .onChange((v) => {
            this.nameWorking = (v ?? '').trim();
          }),
      );

    const scrollLabels: Record<ScrollStartMode, string> = {
      none: 'No auto-scroll',
      'after-frontmatter': 'Top of content (past frontmatter)',
      'first-heading': 'First heading',
      'first-image': 'First image',
    };

    new Setting(contentEl)
      .setName('Initial scroll position')
      .setDesc('Auto-scroll notes to this position for quicker comparisons.')
      .addDropdown((dd) => {
        dd.addOptions(scrollLabels)
          .setValue(this.scrollWorking)
          .onChange((v) => {
            if (
              v === 'after-frontmatter' ||
              v === 'first-heading' ||
              v === 'first-image' ||
              v === 'none'
            ) {
              this.scrollWorking = v;
            } else {
              this.scrollWorking = 'none';
            }
            updateWarning();
          });
      });

    new Setting(contentEl)
      .setName('Synchronised scrolling')
      .setDesc('Scroll both panes together during the session.')
      .addToggle((t) =>
        t.setValue(this.syncScrollWorking).onChange((v) => {
          this.syncScrollWorking = !!v;
          updateWarning();
        }),
      );

    const warningEl = contentEl.createDiv({ cls: 'glicko-warning' });
    warningEl.createEl('p', {
      text:
        'Auto-scroll and synchronised scrolling are both enabled. These settings can conflict with each other if your notes have embedded content that loads slowly. ' +
        'If the notes jump unexpectedly, either disable synchronised scrolling or set auto-scroll to "no auto-scroll".',
    });

    const updateWarning = () => {
      const conflict = this.syncScrollWorking === true && this.scrollWorking !== 'none';
      warningEl.toggleClass('is-visible', conflict);
    };

    updateWarning();

    // Session report settings (shown in edit mode, or create mode when the setting is enabled)
    if (this.showReportSettings) {
      new Setting(contentEl)
        .setName('Generate post-session report')
        .setDesc('Create an Obsidian note summarising the session when it ends.')
        .addToggle((t) =>
          t.setValue(this.reportEnabled).onChange((v) => {
            this.reportEnabled = !!v;
            updateReportVisibility();
          }),
        );

      let reportFolderText: TextComponent;
      const reportFolderSetting = new Setting(contentEl)
        .setName('Report folder')
        .setDesc('Vault-relative path for session reports.')
        .addText((t) => {
          reportFolderText = t;
          t.setPlaceholder(DEFAULT_SETTINGS.sessionReport.folderPath)
            .setValue(this.reportFolderPath)
            .onChange((v) => {
              this.reportFolderPath = (v ?? '').trim();
            });
        })
        .addButton((b) =>
          b
            .setButtonText('Reset')
            .setTooltip('Reset to global default')
            .onClick(() => {
              this.reportFolderPath = this.plugin.settings.sessionReport.folderPath;
              reportFolderText.setValue(this.reportFolderPath);
            }),
        );

      let reportNameText: TextComponent;
      const reportNameSetting = new Setting(contentEl)
        .setName('Report name')
        .setDesc('Available: {{cohort}}, {{date}}, {{datetime}}, {{count}}')
        .addText((t) => {
          reportNameText = t;
          t.setPlaceholder(DEFAULT_SETTINGS.sessionReport.nameTemplate)
            .setValue(this.reportNameTemplate)
            .onChange((v) => {
              this.reportNameTemplate = (v ?? '').trim();
            });
        })
        .addButton((b) =>
          b
            .setButtonText('Reset')
            .setTooltip('Reset to global default')
            .onClick(() => {
              this.reportNameTemplate = this.plugin.settings.sessionReport.nameTemplate;
              reportNameText.setValue(this.reportNameTemplate);
            }),
        );

      let reportTemplateText: TextComponent;
      const reportTemplateSetting = new Setting(contentEl)
        .setName('Report template')
        .setDesc(
          'Vault path to a markdown file with {{glicko:...}} placeholders. Leave blank for built-in.',
        )
        .addText((t) => {
          reportTemplateText = t;
          t.setPlaceholder('e.g. Templates/My Report.md')
            .setValue(this.reportTemplatePath)
            .onChange((v) => {
              this.reportTemplatePath = (v ?? '').trim();
            });
        })
        .addButton((b) =>
          b
            .setButtonText('Reset')
            .setTooltip('Reset to global default')
            .onClick(() => {
              this.reportTemplatePath = this.plugin.settings.sessionReport.reportTemplatePath ?? '';
              reportTemplateText.setValue(this.reportTemplatePath);
            }),
        );

      const updateReportVisibility = () => {
        reportFolderSetting.settingEl.toggle(this.reportEnabled);
        reportNameSetting.settingEl.toggle(this.reportEnabled);
        reportTemplateSetting.settingEl.toggle(this.reportEnabled);
      };

      updateReportVisibility();
    }

    if (this.showFrontmatterSettings) {
      for (const key of FM_PROP_KEYS) {
        const row = this.working[key];
        const baseCfg = this.base[key];

        renderStandardFmPropertyRow(contentEl, key, {
          value: { enabled: row.enabled, property: row.property },
          base: { enabled: baseCfg.enabled, property: baseCfg.property },
          mode: 'cohort',
          onChange: (next) => {
            row.enabled = !!next.enabled;
            row.property = next.property || baseCfg.property;
            this.updateOverriddenFlag(row);
          },
        });
      }
    }

    if (this.mode === 'create') {
      const btns = new Setting(contentEl);
      btns.addButton((b) =>
        b.setButtonText('Cancel').onClick(() => {
          this.finish(undefined);
        }),
      );
      btns.addButton((b) =>
        b
          .setCta()
          .setButtonText('Create cohort')
          .onClick(() => {
            this.finish(this.buildResult());
          }),
      );
    }
  }

  private buildResult(): CohortOptionsResult {
    return {
      overrides: this.buildOverridesPayload(),
      name: this.nameWorking || undefined,
      scrollStart: this.scrollWorking,
      syncScroll: this.syncScrollWorking,
      sessionReport: {
        enabled: this.reportEnabled,
        folderPath: this.reportFolderPath,
        nameTemplate: this.reportNameTemplate || DEFAULT_SETTINGS.sessionReport.nameTemplate,
        reportTemplatePath: this.reportTemplatePath || undefined,
      },
    };
  }

  onClose(): void {
    if (!this._resolved && this.mode === 'edit') {
      this.finish(this.buildResult());
    } else if (!this._resolved) {
      this.finish(undefined);
    }
  }
}
