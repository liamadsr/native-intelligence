/**
 * System documents (migration 366): the ones the workspace's agents are
 * grounded in, a document with a canon_key or the workspace product doc. They
 * can be edited, never deleted or archived. Client-safe: the document panel
 * shows the same line the routes refuse with.
 */

/** Shown wherever a system document's delete or archive is refused. */
export const SYSTEM_DOCUMENT_REFUSAL = 'This is a system document. It can be edited, not deleted.'

/** The SQLSTATE migration 366's guard raises for a system document's delete or archive. */
export const SYSTEM_DOCUMENT_SQLSTATE = 'P0013'

/** A system document is never private (migration 369). */
export const SYSTEM_DOCUMENT_PRIVATE_REFUSAL = "This is a system document. It can't be private."

/** The SQLSTATE migration 369's guard raises when a system document would go private. */
export const SYSTEM_DOCUMENT_PRIVATE_SQLSTATE = 'P0014'
