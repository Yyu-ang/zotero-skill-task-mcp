/**
 * Shared Zotero attachment helpers for deliverable conflict handling.
 */

function normalizeName(name: unknown): string {
  return typeof name === 'string'
    ? name.normalize('NFC').trim().toLocaleLowerCase()
    : '';
}

export async function findChildAttachmentsByFilename(
  parent: any,
  fileName: string
): Promise<any[]> {
  if (!parent || typeof parent.getAttachments !== 'function') return [];
  const wanted = normalizeName(fileName);
  if (!wanted) return [];
  const ids: number[] = parent.getAttachments() ?? [];
  if (!ids.length) return [];

  const Z: any = (globalThis as any).Zotero;
  if (typeof Z?.Items?.getAsync !== 'function') return [];
  const attachments = await Z.Items.getAsync(ids);
  return attachments.filter((att: any) => {
    if (!att || att.deleted) return false;
    if (typeof att.isAttachment === 'function' && !att.isAttachment()) return false;
    let current = '';
    try {
      current =
        typeof att.attachmentFilename === 'string'
          ? att.attachmentFilename
          : typeof att.getFilename === 'function'
            ? att.getFilename()
            : '';
    } catch {
      current = '';
    }
    return normalizeName(current) === wanted;
  });
}

export async function eraseAttachments(items: any[]): Promise<void> {
  for (const item of items) {
    if (!item) continue;
    if (typeof item.eraseTx === 'function') {
      await item.eraseTx();
    } else if (typeof item.erase === 'function') {
      await item.erase();
    } else {
      throw new Error('attachment-delete-unavailable');
    }
  }
}
