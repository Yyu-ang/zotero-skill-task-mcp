import type { SkillDeliverable, SkillGroup, TaskCompleteResult } from './types';
import type { NoteCompletionResult } from './noteCompletion';

/** One queue per skill/library/parent shared by scan, claim, and submit. */
const operations = new Map<string, Promise<unknown>>();

export function taskLibraryID(libraryID?: number): number {
  return libraryID ?? Zotero.Libraries.userLibraryID;
}

export async function withTaskLock<T>(
  skillGroupId: string,
  libraryID: number | undefined,
  itemKey: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([skillGroupId, taskLibraryID(libraryID), itemKey]);
  const previous = operations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  operations.set(key, current);
  try {
    return await current;
  } finally {
    if (operations.get(key) === current) operations.delete(key);
  }
}

export function supportsNoteCompletion(deliverable: SkillDeliverable): boolean {
  return deliverable?.type === 'note' ||
    (deliverable?.type === 'markdown' && deliverable.target === 'note');
}

export function existingNoteResult(
  group: Pick<SkillGroup, 'version' | 'deliverable'>,
  match: Extract<NoteCompletionResult, { status: 'matched' }>,
): TaskCompleteResult {
  return {
    noteKey: match.noteKey,
    deliverableType: group.deliverable.type === 'markdown' ? 'markdown' : 'note',
    deliverableRef: match.noteKey,
    attachmentKey: null,
    completionOrigin: 'existing-note',
    completionRuleVersion: group.version,
    completionCheckedAt: Date.now(),
  };
}
