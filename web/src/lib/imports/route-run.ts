/**
 * What the routes hand an import's run: the person's clients, plus search
 * indexing and record-link syncing for the documents it writes.
 */
import { indexDocument } from '@/lib/ai/embeddings'
import { syncDocumentLinks } from '@/lib/wiki/wikilinks'
import type { WorkImport } from './journal'
import type { RunDeps } from './run'
import type { Who } from './stage'

export function runDepsFor(who: Who, imp: WorkImport): RunDeps {
  return {
    db: who.db,
    svc: who.svc,
    imp,
    userId: who.userId,
    memberId: who.memberId,
    indexDocument: async (id, content) => {
      await indexDocument(who.db, id, who.userId, null, content, who.workspaceId)
    },
    syncLinks: async (id, content) => {
      await syncDocumentLinks(who.db, who.workspaceId, id, content, who.memberId, who.userId)
    },
  }
}
