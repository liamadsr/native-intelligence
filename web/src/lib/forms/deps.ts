/**
 * The real stores behind a form's public side: what the intake route, its
 * two GETs and the hosted page (src/app/f/) pass to ./submit.ts and
 * ./public.ts. Every read and write is the service role's; who is asking is
 * the session's own (requireUser), checked against the form's workspace: a
 * members form is for members, so a guest of the workspace is answered as
 * someone who is not one. A personal link's secret opens its form only while
 * the link is good (not used, not lapsed) and the form still takes invited
 * people: switched to public or members, every personal link ever made stops.
 *
 * A submission's contact is found or made before its row is written (the
 * row links it), but nothing about it changes, and no contact_created loop
 * starts, until the row is stored; and a found contact the form's maker
 * can't see is never changed at all (src/lib/customers/contacts.ts defer).
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { settleCustomerContact, upsertCustomerContact } from '@/lib/customers/contacts'
import { isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { emitRecordsCreated } from '@/lib/flows/emit-record-created'
import { workspaceHasEventFlows } from '@/lib/flows/event-triggers'
import { applyOps, getTable } from '@/lib/tables/store'
import { takeIntakeTest } from '@/lib/website/intake-test'
import { formClientKey } from './client'
import { storeFormFiles } from './file-store'
import { claimInvite, findInvite, findInviteByToken, inviteIsGood, isInviteTokenShape, markInviteStored, releaseInvite } from './invites'
import type { FormGateDeps, FormReadDeps } from './public'
import { claimAttempt, countClientAttempts, countFormAttempts, findFormById, findFormByKey, markAttemptStored, openAttempt, recordAttemptBytes, releaseAttempt, uploadBytesSince } from './store'
import type { FormSubmitDeps } from './submit'
import type { DataForm } from './types'

/** Whether the signed-in person (the request's session) is a member of the workspace. A guest is not: a members form is for members. */
async function memberOf(supabase: SupabaseClient, workspaceId: string): Promise<'member' | 'signed_out' | 'not_member'> {
  const auth = await requireUser()
  if (auth instanceof Response) return 'signed_out'
  const { data, error } = await supabase.from('member').select('id, role').eq('workspace_id', workspaceId).eq('user_id', auth.user.id).maybeSingle()
  if (error) throw new Error(`member read failed: ${error.message}`)
  const me = data as { id: string; role: string | null } | null
  return me && me.role !== 'guest' ? 'member' : 'not_member'
}

/** The form a personal link's secret opens: only while the link is good and its form takes invited people, else null. */
async function formOfInvite(supabase: SupabaseClient, token: string, now: number = Date.now()): Promise<DataForm | null> {
  const invite = await findInviteByToken(supabase, token)
  if (!invite || !inviteIsGood(invite, now)) return null
  const form = await findFormById(supabase, invite.formId)
  return form && form.access === 'invited' ? form : null
}

/** The form a link opens: a form's key, or a good personal link's secret to an invited form; null for anything else. */
export async function findFormByLink(supabase: SupabaseClient, link: string): Promise<DataForm | null> {
  return isInviteTokenShape(link) ? formOfInvite(supabase, link) : findFormByKey(supabase, link)
}

async function columns(supabase: SupabaseClient, form: DataForm) {
  const table = await getTable(supabase, form.workspaceId, form.tableId)
  return table && !table.archived_at ? table.columns : null
}

/** What a page and the GETs read a link with. */
export function formGateDeps(supabase: SupabaseClient): FormGateDeps {
  return {
    findForm: (k) => findFormByKey(supabase, k),
    formOfInvite: (t) => formOfInvite(supabase, t),
    columns: (form) => columns(supabase, form),
    memberOf: (workspaceId) => memberOf(supabase, workspaceId),
    findInvite: (formId, token) => findInvite(supabase, formId, token),
  }
}

/** What the two public GETs read a link with: the page's, and the sender their minute's reads are counted by. */
export function formReadDeps(supabase: SupabaseClient): FormReadDeps {
  return { ...formGateDeps(supabase), clientKey: (req) => formClientKey(req) }
}

/** What a submission is taken with. */
export function formSubmitDeps(supabase: SupabaseClient): FormSubmitDeps {
  return {
    findForm: (k) => findFormByKey(supabase, k),
    formOfInvite: (t) => formOfInvite(supabase, t),
    clientKey: (req) => formClientKey(req),
    memberOf: (_req, workspaceId) => memberOf(supabase, workspaceId),
    countFormAttempts: (formId, sinceIso) => countFormAttempts(supabase, formId, sinceIso),
    countClientAttempts: (clientHash, sinceIso) => countClientAttempts(supabase, clientHash, sinceIso),
    columns: (form) => columns(supabase, form),
    openAttempt: (formId, clientHash) => openAttempt(supabase, formId, clientHash),
    claimAttempt: (args) => claimAttempt(supabase, args),
    claimInvite: (formId, token, nowIso) => claimInvite(supabase, formId, token, nowIso),
    releaseInvite: (inviteId) => releaseInvite(supabase, inviteId),
    markInviteStored: (inviteId, rowId) => markInviteStored(supabase, inviteId, rowId),
    takeTest: (workspaceId, nonce) => takeIntakeTest(supabase, workspaceId, nonce),
    canWrite: async (form) => {
      if (!form.createdBy) return false
      const { data, error } = await supabase.rpc('data_table_editable_by', { p_table_id: form.tableId, p_user_id: form.createdBy })
      if (error) throw new Error(`data_table_editable_by failed: ${error.message}`)
      return data === true
    },
    markStored: (attemptId, formId) => markAttemptStored(supabase, attemptId, formId),
    rowExists: async (form, rowId) => {
      const { data, error } = await supabase.from('data_row').select('id').eq('id', rowId).eq('table_id', form.tableId).eq('workspace_id', form.workspaceId).maybeSingle()
      if (error) throw new Error(`data_row read failed: ${error.message}`)
      return !!data
    },
    recordUploadBytes: (attemptId, bytes) => recordAttemptBytes(supabase, attemptId, bytes),
    uploadBytesSince: (by, sinceIso) => uploadBytesSince(supabase, by, sinceIso),
    storeFiles: (form, rowId, files) => storeFormFiles(supabase, form, rowId, files),
    releaseAttempt: (attemptId) => releaseAttempt(supabase, attemptId),
    makerMemberId: async (form) => {
      if (!form.createdBy) return null
      const { data, error } = await supabase.from('member').select('id').eq('workspace_id', form.workspaceId).eq('user_id', form.createdBy).maybeSingle()
      if (error) throw new Error(`member read failed: ${error.message}`)
      return (data as { id: string } | null)?.id ?? null
    },
    upsertContact: async (form, contact) => {
      const maker = form.createdBy
      if (!maker) return null
      // Found or made now (the row links it); changed, and its loops started, only once the row is stored (see the header).
      const made = await upsertCustomerContact(supabase, { workspaceId: form.workspaceId, ownerUserId: maker }, { ...contact, source: 'web_form' }, { defer: true })
      if (!made) return null
      const owed = made.deferred ?? { patch: null, notify: false }
      return {
        id: made.id,
        settle: async () => {
          // A contact the form's maker can't see (someone's private one) is linked if the table takes it, never changed.
          const patch = owed.patch && (await isContactVisibleTo(supabase, made.id, maker, { grants: false })) ? owed.patch : null
          await settleCustomerContact(supabase, { workspaceId: form.workspaceId, contactId: made.id }, { patch, notify: owed.notify })
        },
      }
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
  }
}
