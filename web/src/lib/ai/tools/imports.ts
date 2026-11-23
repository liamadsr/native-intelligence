import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'
import { loadOwnUpload } from '@/lib/crm/import/file'
import { readEmailAttachment } from '@/lib/email/email-read-service'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { listTeams } from '@/lib/imports/context'
import { listImports, loadImport } from '@/lib/imports/journal'
import { importSummaryView, importView, type ImportView } from '@/lib/imports/preview'
import { linearTeamsFor, stageLinear, stageNotion, stageTaskCsv, readTaskFile, type Who } from '@/lib/imports/stage'
import { guessMapping, TASK_FIELDS } from '@/lib/imports/tasks/columns'

/**
 * Imports for agents (docs/plans/imports.md, phase 4): tasks from a CSV, a
 * Notion export, Linear issues.
 *
 *   stage_import_from_file   a file the person gave them (a chat upload, or
 *                            an attachment of an email in their mailbox): a
 *                            task CSV or a Notion export, planned and kept
 *                            as a STAGED import. Returns its preview.
 *   stage_linear_import      issues of the workspace's Linear connection
 *                            (only for the person who connected it), staged.
 *   list_imports             their recent imports, with status and summary.
 *
 * An agent never applies or undoes an import. Both are the person's own act
 * on the preview page (`open_url`): Import there runs it on THEIR session, so
 * every task, document and table is made under their own row security, and
 * Undo there takes it back the same way. Staging writes only the journal.
 *
 * The file's words (titles, headers, page names) are someone else's text:
 * fenced as untrusted wherever they come back. Each tool refuses an
 * unattended turn (a loop, a run): only the person brings work in.
 */
export function createImportTools(userId: string, supabase: SupabaseClient, workspaceId: string, opts: { unattended?: boolean } = {}) {
  const refusal = { success: false, error: "Only on the person's own turn: they have to ask for this themselves." }

  const whoAmI = async (): Promise<Who | null> => {
    const { data } = await supabase.from('member').select('id, role').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle()
    const m = data as { id: string; role: string | null } | null
    if (!m || m.role === 'guest') return null
    return { db: supabase, svc: getServiceClient(), workspaceId, userId, memberId: m.id }
  }

  /** A preview for the model; `fence` wraps the file's own words (each tool passes its own wrapUntrusted). */
  const forModel = (view: ImportView, fence: (text: string | null | undefined) => string) => ({
    import_id: view.id,
    status: view.status,
    source: view.source,
    label: fence(view.label),
    counts: view.counts,
    notes: view.notes.map((n) => ({ level: n.level, text: fence(n.text) })),
    ...(view.tasks ? { sample_tasks: view.tasks.slice(0, 10).map((t) => ({ from: t.source, title: fence(t.title), status: t.status, assignee: t.assignee, due_date: t.due_date, project: fence(t.project), labels: t.labels.map(fence) })) } : {}),
    ...(view.tree ? { tree: view.tree.slice(0, 40).map((n) => ({ kind: n.kind, name: fence(n.name), parent: n.parent, ...(n.columns ? { columns: n.columns.map(fence) } : {}) })) } : {}),
    open_url: `/account/settings/import?open=${view.id}`,
  })

  const staged = (view: ImportView, fence: (text: string | null | undefined) => string) => ({
    success: true,
    preview: forModel(view, fence),
    message:
      'Nothing has been made yet. Tell them in a few lines what this import will make (the counts and the notes that matter) and give them open_url: they check the preview there and press Import to run it. You cannot run it for them.',
  })

  return {
    stage_import_from_file: tool({
      description:
        'Prepare an import from a file the person gave you, and get its preview: a CSV or Excel file of TASKS (each row becomes a task: title, status, priority, assignee, due date, project, labels), or a Notion export (.zip of "Markdown & CSV": pages become documents in Drive folders, databases become tables). ' +
        'Nothing is made: the person reviews the preview at open_url and presses Import there. For a contacts/customers spreadsheet use read_contact_file instead.',
      inputSchema: z.object({
        kind: z.enum(['tasks', 'notion']).describe('tasks: a CSV/Excel of tasks. notion: a Notion export .zip.'),
        storage_path: z.string().min(1).max(300).optional().describe('A file they sent you: its storage_path, from the "## Chat File Uploads" section or a texted file\'s line.'),
        email_message_id: z.string().min(1).max(300).optional().describe('Or a file they emailed: the message id (from read_email) it is attached to, with file_name.'),
        file_name: z.string().max(200).optional().describe('The file\'s own name (e.g. "tasks.csv"); required with email_message_id.'),
        team: z.string().max(120).optional().describe('tasks only: the team the tasks go into, by name. Defaults to the workspace\'s first team they can use.'),
        columns: z
          .record(z.string().max(120), z.enum(TASK_FIELDS))
          .optional()
          .describe('tasks only: corrections to the guessed mapping, header → field (title, description, status, priority, assignee, due_date, project, labels, skip).'),
        only_me: z.boolean().optional().describe('notion only: true makes everything private to them. Default: everyone in the workspace.'),
      }),
      execute: async (input) => {
        if (opts.unattended) return refusal
        const fence = (text: string | null | undefined) => wrapUntrusted(text, 'FILE') ?? ''
        if (!!input.storage_path === !!input.email_message_id) return { success: false, error: 'Name the file one way: storage_path (sent to you) or email_message_id with file_name (emailed).' }
        const who = await whoAmI()
        if (!who) return { success: false, error: 'Only a member of this workspace (not a guest) can import into it.' }
        let bytes: Uint8Array
        let name: string
        if (input.email_message_id) {
          name = input.file_name?.trim() ?? ''
          if (!name) return { success: false, error: 'Pass file_name: the attachment\'s name, as read_email lists it.' }
          const emailed = await readEmailAttachment(userId, input.email_message_id, name, workspaceId)
          if (!emailed) return { success: false, error: `No attachment named "${name}" (under 10 MB) on that message in a mailbox you can read.` }
          bytes = emailed.bytes
        } else {
          const loaded = await loadOwnUpload(supabase, userId, input.storage_path!)
          if (!loaded.ok) return { success: false, error: loaded.error }
          bytes = loaded.bytes
          const ext = input.storage_path!.split('.').pop() ?? ''
          const given = input.file_name?.trim() || input.storage_path!.split('/').pop() || 'file'
          name = given.toLowerCase().endsWith(`.${ext}`) ? given : `${given}.${ext}`
        }
        try {
          if (input.kind === 'notion') {
            const out = await stageNotion(who, { bytes, fileName: name, visibility: input.only_me ? 'private' : 'workspace' })
            if (!out.ok) return { success: false, error: out.error }
            return staged(await importView(who.db, who.svc, out.imp), fence)
          }
          const sheet = await readTaskFile(bytes, name)
          if (!sheet.ok) return { success: false, error: sheet.error }
          const mapping: string[] = guessMapping(sheet.sheet.headers)
          for (const [header, field] of Object.entries(input.columns ?? {})) {
            const i = sheet.sheet.headers.findIndex((h) => h.trim().toLowerCase() === header.trim().toLowerCase())
            if (i < 0) return { success: false, error: `The file has no column "${header.slice(0, 60)}". Its columns: ${sheet.sheet.headers.map((h) => fence(h)).join(', ')}` }
            mapping[i] = field
          }
          const teams = await listTeams(who.db, workspaceId, who.memberId)
          const team = input.team ? teams.find((t) => t.name.toLowerCase() === input.team!.trim().toLowerCase() || t.key?.toLowerCase() === input.team!.trim().toLowerCase()) : teams[0]
          if (!team) return { success: false, error: input.team ? `No team named "${input.team}" they can use. Teams: ${teams.map((t) => t.name).join(', ')}` : 'There is no team to put the tasks in.' }
          const out = await stageTaskCsv(who, { bytes, fileName: name, mapping, teamId: team.id })
          if (!out.ok) {
            return {
              success: false,
              error: out.error,
              columns: sheet.sheet.headers.map((h, i) => ({ header: fence(h), guessed: mapping[i] })),
              message: 'If the mapping is wrong, call again with `columns` (header → field).',
            }
          }
          return { ...staged(await importView(who.db, who.svc, out.imp), fence), team: team.name, mapping: sheet.sheet.headers.map((h, i) => ({ header: fence(h), field: mapping[i] })) }
        } catch (e) {
          return { success: false, error: `The import could not be prepared: ${e instanceof Error ? e.message : String(e)}` }
        }
      },
    }),

    stage_linear_import: tool({
      description:
        'Prepare an import of issues from the workspace\'s connected Linear (only the person who connected it can), and get its preview: issues with their statuses, labels, projects, parents and assignees (matched to people already here by email). ' +
        'Without linear_team, lists the Linear teams to choose from. Nothing is made: the person reviews the preview at open_url and presses Import there.',
      inputSchema: z.object({
        linear_team: z.string().max(120).optional().describe('The Linear team, by name or key (e.g. "ENG"). Omit to list them.'),
        team: z.string().max(120).optional().describe('Our team the issues go into, by name. Defaults to one with the same name, else the first.'),
        include_closed: z.boolean().optional().describe('Also completed and canceled issues. Default false.'),
      }),
      execute: async ({ linear_team, team, include_closed }) => {
        if (opts.unattended) return refusal
        const fence = (text: string | null | undefined) => wrapUntrusted(text, 'FILE') ?? ''
        const who = await whoAmI()
        if (!who) return { success: false, error: 'Only a member of this workspace (not a guest) can import into it.' }
        try {
          const teams = await linearTeamsFor(who)
          if (!teams.ok) return { success: false, error: teams.error }
          if (!linear_team) return { success: true, linear_teams: teams.linear.map((t) => ({ key: t.key, name: fence(t.name) })), our_teams: teams.ours.map((t) => t.name), message: 'Ask which Linear team to import (and into which of our teams, if not the same name), then call again.' }
          const want = linear_team.trim().toLowerCase()
          const theirs = teams.linear.find((t) => t.key.toLowerCase() === want || t.name.toLowerCase() === want)
          if (!theirs) return { success: false, error: `No Linear team "${linear_team}". Teams: ${teams.linear.map((t) => t.key).join(', ')}` }
          const ours = (team && teams.ours.find((t) => t.name.toLowerCase() === team.trim().toLowerCase())) || teams.ours.find((t) => t.name.toLowerCase() === theirs.name.toLowerCase()) || teams.ours[0]
          if (!ours) return { success: false, error: team ? `No team named "${team}" here.` : 'There is no team here to put the issues in.' }
          const out = await stageLinear(who, { teams: [{ linearTeamId: theirs.id, teamId: ours.id }], includeClosed: include_closed === true, createStates: true })
          if (!out.ok) return { success: false, error: out.error }
          return { ...staged(await importView(who.db, who.svc, out.imp), fence), into_team: ours.name }
        } catch (e) {
          return { success: false, error: `The import could not be prepared: ${e instanceof Error ? e.message : String(e)}` }
        }
      },
    }),

    list_imports: tool({
      description: 'Their recent imports of tasks, Linear issues and Notion pages: status, counts, summary, and the page to open each (to import a prepared one, or undo a finished one, which they do there).',
      inputSchema: z.object({ import_id: z.string().uuid().optional().describe('One import, for its full preview.') }),
      execute: async ({ import_id }) => {
        const fence = (text: string | null | undefined) => wrapUntrusted(text, 'FILE') ?? ''
        const who = { userId, workspaceId }
        const svc = getServiceClient()
        if (import_id) {
          const imp = await loadImport(svc, import_id, who)
          if (!imp || imp.status === 'discarded') return { success: false, error: 'No import of theirs with that id here.' }
          return { success: true, import: forModel(await importView(supabase, svc, imp), fence) }
        }
        const rows = await listImports(svc, who, 10)
        return {
          success: true,
          imports: rows.map((r) => {
            const v = importSummaryView(r)
            return { import_id: v.id, source: v.source, label: fence(v.label), status: v.status, created_at: v.created_at, summary: v.summary, open_url: `/account/settings/import?open=${v.id}` }
          }),
        }
      },
    }),
  }
}
