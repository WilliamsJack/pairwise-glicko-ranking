import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type GlickoPlugin from '../main';
import { ConfirmModal } from '../ui/ConfirmModal';
import { applyIdTransferPlan, planIdTransfer } from '../utils/IdTransfer';
import { withNotice } from '../utils/safe';

export async function migrateIdPropertyName(
  app: App,
  plugin: GlickoPlugin,
  newPropName: string,
): Promise<void> {
  const oldPropName = plugin.settings.idPropertyName;
  if (newPropName === oldPropName) return;

  const files = app.vault.getMarkdownFiles();
  if (files.length === 0) {
    plugin.settings.idPropertyName = newPropName;
    await plugin.saveSettings();
    return;
  }

  // Auto-detect location per file: a rename writes to whichever location the ID was found in
  const plan = await withNotice('Scanning notes for existing IDs...', () =>
    planIdTransfer(app, files, { propertyName: oldPropName }, { propertyName: newPropName }),
  );

  if (plan.wouldUpdate === 0) {
    plugin.settings.idPropertyName = newPropName;
    await plugin.saveSettings();
    new Notice(`Note ID property changed to "${newPropName}".`);
    return;
  }

  const ok = await new ConfirmModal(
    app,
    'Rename note ID property?',
    `Rename "${oldPropName}" to "${newPropName}" in ${plan.wouldUpdate} note${plan.wouldUpdate === 1 ? '' : 's'}? This is required to keep your ratings working.`,
    'Yes, rename',
    'Cancel',
  ).openAndConfirm();

  if (!ok) {
    // Revert - migration is mandatory
    new Notice('Note ID property change cancelled.');
    return;
  }

  const res = await applyIdTransferPlan(app, plan, {
    noticeMessage: `Renaming "${oldPropName}" to "${newPropName}"...`,
  });

  plugin.settings.idPropertyName = newPropName;
  await plugin.saveSettings();
  new Notice(`Renamed note ID property in ${res.updated} note${res.updated === 1 ? '' : 's'}.`);
}
