import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadImportBatch, recentImportBatches, reviewItems } from '@/lib/crm/import/batch'
import { contactFilePreview, contactFileRecords, loadOwnUpload, readContactFile } from '@/lib/crm/import/file'
import { readEmailAttachment } from '@/lib/email/email-read-service'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { runImport, runUndo } from '@/lib/crm/import/run'
import { COLUMN_TARGETS } from '@/lib/crm/import/sources/spreadsheet'
import { IMPORT_SOURCE_LABEL } from '@/lib/crm/import/record'
import { importedPeople } from '@/lib/crm/import/summary'

/**
 * Bringing the owner's existing customers in (roadmap track G,
 * docs/plans/customer-import.md):
 *
 *   read_contact_file      read a spreadsheet or phone contacts they sent
 *                          (chat upload, texted file, or an attachment of
 *                          an email in their mailbox) and map its columns;
 *                          returns the columns it could not map, the only
 *                          ones to ask about. The customer export of a tool
 *                          it knows (QuickBooks, Stripe, HubSpot, Pipedrive,
 *                          Mailchimp, Jobber, Housecall Pro, Square) maps
 *                          every column itself: nothing to ask.
 *   import_contact_file    import it through the one importer: deduped
 *                          against the CRM, never over their own edits,
 *                          undoable as a whole. Small files finish in the
 *                          call; large ones run in the background and the
 *                          owner gets a text when done.
 *   import_stripe_customers
 *                          the customers of the Stripe account they
 *                          connected for payments, with their payments on
 *                          their timelines: read and imported in the
 *                          background, the owner texted when done.
 *   list_contact_imports   their recent imports: status, counts, the
 *                          contacts to check.
 *   undo_contact_import    take one import back as a whole.
 *
 * Read-only toward the world: an import never sends, enriches or reaches
 * out. Not attended only: they run on the person's own text turn
 * (person_remote) too. Each refuses an unattended turn (a loop, a run): only
 * the owner brings their customers in or takes them out.
 */
export function createContactImportTools(userId: string, supabase: SupabaseClient, workspaceId: string, opts: { unattended?: boolean } = {}) {
  const unattendedRefusal = { success: false, error: "Only on the person's own turn: they have to ask for this themselves." }
  const fileInput = {
    storage_path: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('A file they sent you: its storage_path, from the "## Chat File Uploads" section or the "[They texted …: storage_path …]" line of a text.'),
    email_message_id: z.string().min(1).max(300).optional().describe('Or a file they emailed: the message id (messageId from read_email) it is attached to, with file_name its attachment name.'),
    file_name: z.string().max(200).optional().describe('The file\'s own name (e.g. "customers.xlsx"): required with email_message_id (the attachment\'s name, as read_email lists it); otherwise it names the import in the summary.'),
    columns: z
      .record(z.string().max(120), z.enum(COLUMN_TARGETS))
      .optional()
      .describe('Their answers for columns read_contact_file could not map: the column\'s number from read_contact_file (e.g. "#3") → field. "note" keeps the column in the contact\'s notes as "Header: value"; "skip" drops it.'),
  }

  const read = async (input: { storage_path?: string; email_message_id?: string; file_name?: string; columns?: Record<string, string> }) => {
    if (!!input.storage_path === !!input.email_message_id) return { ok: false as const, error: 'Name the file one way: storage_path (sent to you) or email_message_id with file_name (emailed).' }
    if (input.email_message_id) {
      const fileName = input.file_name?.trim()
      if (!fileName) return { ok: false as const, error: 'Pass file_name: the attachment\'s name, as read_email lists it.' }
      const emailed = await readEmailAttachment(userId, input.email_message_id, fileName, workspaceId)
      if (!emailed) return { ok: false as const, error: `No attachment named "${fileName}" (under 10 MB) on that message in a mailbox you can read.` }
      const file = await readContactFile(emailed.bytes, fileName, input.columns)
      return file.ok ? { ok: true as const, file, name: fileName } : { ok: false as const, error: file.error }
    }
    const storagePath = input.storage_path!
    const loaded = await loadOwnUpload(supabase, userId, storagePath)
    if (!loaded.ok) return { ok: false as const, error: loaded.error }
    const name = input.file_name?.trim() || storagePath.split('/').pop() || storagePath
    // The stored object's extension is the real one (a texted file is named by what its bytes are).
    const storedExt = storagePath.split('.').pop() ?? ''
    const file = await readContactFile(loaded.bytes, name.toLowerCase().endsWith(`.${storedExt}`) ? name : `${name}.${storedExt}`, input.columns)
    return file.ok ? { ok: true as const, file, name } : { ok: false as const, error: file.error }
  }

  return {
    read_contact_file: tool({
      description:
        'Read a spreadsheet (CSV or Excel .xlsx) or phone contacts file (.vcf) the person sent you or emailed (an attachment read_email lists), to bring their existing customers into the CRM. ' +
        'Returns how many rows, each column\'s field, and `unmapped`: the only columns to ask them about (show a sample value; ask in one short message). ' +
        'The customer export of QuickBooks, Stripe, HubSpot, Pipedrive, Mailchimp, Jobber, Housecall Pro or Square is recognised (`app`) and maps every column itself. ' +
        'When nothing is unmapped, call import_contact_file straight away; there is nothing to confirm.',
      inputSchema: z.object(fileInput),
      execute: async (input) => {
        if (opts.unattended) return unattendedRefusal
        const read_ = await read(input)
        if (!read_.ok) return { success: false, error: read_.error }
        const preview = contactFilePreview(read_.file)
        // The file's own words (headers, sample values) are someone's text: data, never instructions.
        const fence = (text: string | null | undefined) => wrapUntrusted(text, 'FILE') ?? ''
        return {
          success: true,
          file_name: read_.name,
          ...preview,
          ...(preview.format === 'spreadsheet'
            ? {
                columns: preview.columns.map((c) => ({ ...c, header: fence(c.header), samples: c.samples.map(fence) })),
                unmapped: preview.unmapped.map((c) => ({ ...c, header: fence(c.header), samples: c.samples.map(fence) })),
              }
            : { sample: preview.sample.map((c) => ({ name: fence(c.name), emails: c.emails, phones: (c.phones ?? []).map(fence) })) }),
          message: preview.unmapped.length
            ? 'Ask them, in one message, what each unmapped column is (or whether to keep it in notes), then call import_contact_file with their answers in `columns`, keyed by column number ("#3").'
            : preview.app
              ? `A ${preview.app} export: every column is mapped. Call import_contact_file now.`
              : 'Every column is mapped: call import_contact_file now.',
        }
      },
    }),

    import_contact_file: tool({
      description:
        'Import a spreadsheet or phone contacts file into the CRM: every row deduped against the contacts they have (email, phone, name), never overwriting what they edited, tagged with its source, and undoable as a whole (undo_contact_import). ' +
        'Nothing is sent to anyone and nobody is enriched. Pass `columns` for the columns read_contact_file could not map. ' +
        'Small files finish now and return the summary to tell them; large ones run in the background and they get a text when done.',
      inputSchema: z.object({
        ...fileInput,
        relationship: z
          .enum(['customer', 'lead', 'contact'])
          .optional()
          .describe(
            'What the people in the file are to the business, when they say. Defaults: their own spreadsheet, customer; a QuickBooks, Stripe, Square, Jobber or Housecall Pro export, customer; a CRM or mailing list export, what its columns say; phone contacts, none (mixed). Lead for prospects.',
          ),
      }),
      execute: async ({ relationship, ...input }) => {
        if (opts.unattended) return unattendedRefusal
        const read_ = await read(input)
        if (!read_.ok) return { success: false, error: read_.error }
        const records = contactFileRecords(read_.file, relationship)
        const out = await runImport(supabase, { workspaceId, userId, source: read_.file.source, label: read_.name, records })
        if (out.status === 'failed') return { success: false, error: `The import failed: ${out.error}` }
        if (out.status === 'running') {
          return {
            success: true,
            status: 'running',
            batch_id: out.batchId,
            rows: out.total,
            message: `Importing ${out.total.toLocaleString('en-US')} rows in the background. Tell them in one line; they get a text with the summary when it's done.`,
          }
        }
        return {
          success: true,
          status: 'done',
          batch_id: out.batchId,
          imported: out.imported,
          summary: out.summary,
          to_check: out.toCheck,
          message: 'Tell them the summary as is.' + (out.toCheck.length ? ' The ones to check may be someone they already have: offer to show them.' : ''),
        }
      },
    }),

    import_stripe_customers: tool({
      description:
        'Bring their customers in from the Stripe account they connected for payments (no sign-in of its own): every Stripe customer, and anyone who paid without one, with their payments on their timelines. ' +
        'Deduped against the CRM like a file, never over their edits, undoable as a whole (undo_contact_import); nothing is sent, nobody is enriched, nothing in Stripe changes. ' +
        'Runs in the background: they get a text with the summary when it is done. Do it when they ask; nothing to confirm. Stripe not connected: they can export their customers from Stripe and send the file instead.',
      inputSchema: z.object({}),
      execute: async () => {
        if (opts.unattended) return unattendedRefusal
        const { startStripeImport } = await import('@/lib/crm/import/connected')
        const started = await startStripeImport(supabase, { userId, workspaceId })
        if (!started.ok) return { success: false, error: started.error }
        return {
          success: true,
          status: 'running',
          batch_id: started.batchId,
          message: started.alreadyRunning
            ? 'Their Stripe import is already running. Tell them in one line; they get a text when it is done.'
            : 'Importing their Stripe customers in the background. Tell them in one line; they get a text with the summary when it is done.',
        }
      },
    }),

    list_contact_imports: tool({
      description:
        'Their own recent imports of existing customers (files and app exports, phone contacts, Google Contacts, HubSpot, Brevo, Stripe): status, counts and summary. With batch_id, also the new contacts to check (each may be someone they already have).',
      inputSchema: z.object({
        batch_id: z.string().uuid().optional().describe('One import, for its contacts to check.'),
      }),
      execute: async ({ batch_id }) => {
        if (batch_id) {
          const batch = await loadImportBatch(supabase, batch_id)
          if (!batch || batch.workspace_id !== workspaceId || batch.user_id !== userId) return { success: false, error: 'No import of theirs with that id here.' }
          return { success: true, import: describe(batch), to_check: await reviewItems(supabase, batch.id) }
        }
        const batches = await recentImportBatches(supabase, workspaceId, 5, userId)
        return { success: true, imports: batches.map(describe) }
      },
    }),

    undo_contact_import: tool({
      description:
        'Take one import back as a whole: the contacts it added are removed (unless they have been worked with since: then only its tag comes off), what it changed on contacts they had goes back, its timeline rows go. ' +
        'Their own edits since the import stay. With no batch_id, the latest import. Do it when they ask ("undo import"); nothing to confirm.',
      inputSchema: z.object({
        batch_id: z.string().uuid().optional().describe('The import to undo (from list_contact_imports). Omit for the latest.'),
      }),
      execute: async ({ batch_id }) => {
        if (opts.unattended) return unattendedRefusal
        let id = batch_id
        if (!id) {
          // Their latest import, whatever its state: an "undo import" said twice must not reach back to an older one.
          const [latest] = await recentImportBatches(supabase, workspaceId, 1, userId)
          if (!latest) return { success: false, error: 'There is no import of theirs to undo.' }
          if (latest.status === 'undone') return { success: false, error: 'Their latest import was already undone. To undo an older one, name it (list_contact_imports).' }
          id = latest.id
        }
        const out = await runUndo(supabase, { workspaceId, batchId: id, userId })
        if (out.status === 'refused') return { success: false, error: out.error }
        if (out.status === 'running') return { success: true, status: 'running', message: 'Undoing it in the background. Tell them in one line; they get a text when it is done.' }
        return { success: true, status: 'done', summary: out.text, message: 'Tell them the summary as is.' }
      },
    }),
  }
}

function describe(batch: Awaited<ReturnType<typeof recentImportBatches>>[number]) {
  return {
    batch_id: batch.id,
    source: IMPORT_SOURCE_LABEL[batch.source],
    label: batch.label,
    status: batch.status,
    started_at: batch.created_at,
    imported: importedPeople(batch.counts),
    counts: batch.counts,
    summary: batch.summary,
  }
}
