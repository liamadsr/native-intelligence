/**
 * An import's progress in the work ledger (kind `work_import`): a row opened
 * when it starts, a step per chunk ("Imported 400 of 1,200"), finished with
 * the summary or failed with the error; an undo is a row of its own.
 *
 * Owner: the person who ran it. Run key `import:<id>` (an undo:
 * `import-undo:<id>`), so a re-run after a failure finds its row. Service
 * client only; fail-soft, like src/lib/work/import-mirror.ts: the ledger
 * never stops an import.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, startWork, type WorkHandle } from '@/lib/work/recorder'
import { WORK_KINDS } from '@/lib/work/types'
import type { WorkImport } from './journal'
import type { ImportSource } from './types'

/** A running import with no step for this long is failed by the reaper. */
export const IMPORT_DEADLINE_MS = 2 * 60 * 60_000

export const SOURCE_NAME: Record<ImportSource, string> = {
  task_csv: 'a task CSV',
  linear: 'Linear',
  notion: 'Notion',
}

function warn(what: string, err: unknown) {
  console.warn(`[imports] ledger (${what}) failed:`, err instanceof Error ? err.message : err)
}

export interface LedgerRun {
  step(done: number, total: number): Promise<void>
  finish(summary: string): Promise<void>
  fail(message: string): Promise<void>
}

const NOOP: LedgerRun = { step: async () => {}, finish: async () => {}, fail: async () => {} }

export async function openLedger(svc: SupabaseClient, imp: WorkImport, mode: 'import' | 'undo'): Promise<LedgerRun> {
  if (!imp.member_id) return NOOP
  const runKey = `${mode === 'undo' ? 'import-undo' : 'import'}:${imp.id}`
  let handle: WorkHandle | null = null
  try {
    const existing = await findWork(svc, { kind: WORK_KINDS.workImport, runKey })
    handle = existing
      ? attachWork(svc, existing, { running: IMPORT_DEADLINE_MS })
      : await startWork(svc, {
          workspaceId: imp.workspace_id,
          memberId: imp.member_id,
          kind: WORK_KINDS.workImport,
          title: mode === 'undo' ? `Undoing an import from ${SOURCE_NAME[imp.source]}` : `Importing from ${SOURCE_NAME[imp.source]}`,
          actor: 'system',
          status: 'running',
          runKey,
          deadlines: { running: IMPORT_DEADLINE_MS },
          source: { import_id: imp.id, provider: imp.source },
        })
  } catch (err) {
    warn('open', err)
    return NOOP
  }
  const h = handle
  return {
    async step(done, total) {
      try {
        await h.step(`${mode === 'undo' ? 'Undid' : 'Imported'} ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`, { done, total })
        await h.flush()
      } catch (err) {
        warn('step', err)
      }
    },
    async finish(summary) {
      try {
        await h.finish({ summary })
      } catch (err) {
        warn('finish', err)
      }
    },
    async fail(message) {
      try {
        await h.fail(message)
      } catch (err) {
        warn('fail', err)
      }
    },
  }
}
