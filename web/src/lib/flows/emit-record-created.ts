import { inngest } from '@/lib/inngest/client'

type Send = (events: Array<{ name: string; id: string; ts?: number; data: Record<string, unknown> }>) => Promise<unknown>

/** How long after a person adds a row its loops run: long enough for them to have typed something in it. */
export const RECORD_CREATED_PERSON_DELAY_MS = 5 * 60 * 1000
/** Rows of one batch that each fire: a paste of a thousand rows starts no thousand runs. */
export const RECORD_CREATED_MAX_PER_BATCH = 50

/** Who added the rows. Only these two ever emit. */
export type RecordCreatedSource = 'form' | 'person'

/**
 * Emit `flow/record.created` for rows just added to a table (forms phase 2),
 * once per row (the event id is keyed on it):
 *
 *   form     a form's submission (src/app/api/intake/forms/[key]/route.ts):
 *            delivered at once;
 *   person   a person adding rows by hand (the tables ops route): delivered
 *            RECORD_CREATED_PERSON_DELAY_MS later (Inngest `ts`), so the run
 *            reads what they typed. flowDispatchOnRecordCreated skips a row
 *            still blank, archived or gone by then.
 *
 * Nothing else emits: a row an agent, an import, a sync or a loop's own step
 * wrote never fires a loop (the loop guard). Ids only. Never throws.
 */
export async function emitRecordsCreated(
  args: { workspaceId: string; tableId: string; rowIds: readonly string[]; source: RecordCreatedSource; now?: number },
  deps: { send?: Send } = {},
): Promise<number> {
  const now = args.now ?? Date.now()
  // The database's own spelling of the id: the dispatcher compares it with the row's table.
  const tableId = args.tableId.toLowerCase()
  const events = [...new Set(args.rowIds)].slice(0, RECORD_CREATED_MAX_PER_BATCH).map((rowId) => ({
    name: 'flow/record.created',
    id: `record-created:${rowId}`,
    ...(args.source === 'person' ? { ts: now + RECORD_CREATED_PERSON_DELAY_MS } : {}),
    data: { workspace_id: args.workspaceId, table_id: tableId, row_id: rowId, source: args.source, created_at: new Date(now).toISOString() },
  }))
  if (!events.length) return 0
  try {
    // One send for the whole batch: a paste of fifty rows is one call, not fifty in a row.
    await (deps.send ?? ((e) => inngest.send(e as never)))(events)
    return events.length
  } catch (err) {
    console.error('[flows] record created inngest.send failed', err instanceof Error ? err.message : 'unknown')
    return 0
  }
}
