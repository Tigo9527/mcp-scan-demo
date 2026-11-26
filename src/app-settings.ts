/** Runtime application settings. The AI chat link is hidden until an admin enables it. */
import { loadAiChatEntryEnabled, saveAiChatEntryEnabled } from './db.js';

let aiChatEntryEnabled = false;

export function isAiChatEntryEnabled(): boolean {
  return aiChatEntryEnabled;
}

export async function reloadAppSettingsFromDb(): Promise<void> {
  aiChatEntryEnabled = await loadAiChatEntryEnabled();
}

export async function setAiChatEntryEnabled(enabled: boolean): Promise<void> {
  await saveAiChatEntryEnabled(enabled);
  aiChatEntryEnabled = enabled;
}
