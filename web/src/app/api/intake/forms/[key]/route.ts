import { requireUser } from '@/lib/api-auth'
import { upsertCustomerContact } from '@/lib/customers/contacts'
import { emitRecordsCreated } from '@/lib/flows/emit-record-created'
import { workspaceHasEventFlows } from '@/lib/flows/event-triggers'
import { formClientKey } from '@/lib/forms/client'
import { formCorsHeaders, handleFormSubmit } from '@/lib/forms/submit'
import { claimAttempt, countClientAttempts, countFormAttempts, findFormByKey, markAttemptStored, openAttempt, releaseAttempt } from '@/lib/forms/store'
import { getServiceClient } from '@/lib/supabase/service'
import { applyOps, getTable } from '@/lib/tables/store'

export const dynamic = 'force-dynamic'

/**
 * POST /api/intake/forms/<key>: a submission to a form (forms phase 1).
 * Public: the key opens the form, and all it can do is add one row through
 * the form's own fields. See src/lib/forms/submit.ts for the order of checks.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const supabase = getServiceClient()
  return handleFormSubmit(request, key, {
    findForm: (k) => findFormByKey(supabase, k),
    clientKey: (req) => formClientKey(req),
    memberOf: async (_req, workspaceId) => {
      const auth = await requireUser()
      if (auth instanceof Response) return 'signed_out'
      const { data, error } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', auth.user.id).maybeSingle()
      if (error) throw new Error(`member read failed: ${error.message}`)
      return data ? 'member' : 'not_member'
    },
    countFormAttempts: (formId, sinceIso) => countFormAttempts(supabase, formId, sinceIso),
    countClientAttempts: (clientHash, sinceIso) => countClientAttempts(supabase, clientHash, sinceIso),
    columns: async (form) => {
      const table = await getTable(supabase, form.workspaceId, form.tableId)
      return table && !table.archived_at ? table.columns : null
    },
    openAttempt: (formId, clientHash) => openAttempt(supabase, formId, clientHash),
    claimAttempt: (args) => claimAttempt(supabase, args),
    canWrite: async (form) => {
      if (!form.createdBy) return false
      const { data, error } = await supabase.rpc('data_table_editable_by', { p_table_id: form.tableId, p_user_id: form.createdBy })
      if (error) throw new Error(`data_table_editable_by failed: ${error.message}`)
      return data === true
    },
    markStored: (attemptId, formId) => markAttemptStored(supabase, attemptId, formId),
    releaseAttempt: (attemptId) => releaseAttempt(supabase, attemptId),
    upsertContact: async (form, contact) => {
      if (!form.createdBy) return null
      const made = await upsertCustomerContact(supabase, { workspaceId: form.workspaceId, ownerUserId: form.createdBy }, { ...contact, source: 'web_form' })
      return made?.id ?? null
    },
    writeRow: async (form, row) => {
      // Written as the form's maker: when they can no longer change the table, the form takes nothing.
      if (!form.createdBy) return { ok: false, reason: 'unavailable', error: 'the form has no maker to write as' }
      const written = await applyOps(
        supabase,
        form.workspaceId,
        form.tableId,
        { baseVersion: null, ops: [{ op: 'insert_rows', rows: [row] }] },
        { userId: form.createdBy, asUserId: form.createdBy, source: 'form', reason: `Submitted through the form ${form.name}`, sourceRef: `form:${form.id}` },
      )
      if (written.ok) return { ok: true }
      return written.reason === 'invalid' ? { ok: false, reason: 'invalid', error: written.error } : { ok: false, reason: 'unavailable', error: `${written.reason}: ${written.error}` }
    },
    // The table's record_created loops (forms phase 2): how the workspace hears of a submission and acts on it.
    afterStored: async (form, rowId) => {
      if (await workspaceHasEventFlows(supabase, { workspaceId: form.workspaceId, triggerType: 'record_created', tableId: form.tableId })) {
        await emitRecordsCreated({ workspaceId: form.workspaceId, tableId: form.tableId, rowIds: [rowId], source: 'form' })
      }
    },
  })
}

/** The browser's CORS preflight: allowed for a public form's listed origins (or any, when none are listed). */
export async function OPTIONS(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const origin = request.headers.get('origin')
  const found = await findFormByKey(getServiceClient(), key).catch(() => null)
  return new Response(null, { status: found ? 204 : 404, headers: formCorsHeaders(origin, found) })
}
