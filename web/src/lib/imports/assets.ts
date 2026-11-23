/**
 * Where an import's uploaded files live (docs/plans/imports.md): the
 * `attachments` bucket, under the importer's own folder. A file is served
 * only through GET /api/account/imports/assets/[id], which first reads one
 * of the import's documents that links it on the CALLER's client, so it
 * shows only to someone who can read a page it is on.
 */

/** The address a document body links an imported file by. */
export function assetAddress(itemId: string): string {
  return `/api/account/imports/assets/${itemId}`
}

/** A file name safe in a storage path: letters, digits, dot, dash, underscore. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^\.+/, '')
  return (cleaned || 'file').slice(-120)
}

export function assetStoragePath(userId: string, importId: string, itemId: string, fileName: string): string {
  return `${userId}/imports/${importId}/${itemId}-${safeFileName(fileName)}`
}

/** Where a staged Notion export waits for Apply. */
export function uploadStoragePath(userId: string, importId: string): string {
  return `${userId}/imports/${importId}/export.zip`
}
