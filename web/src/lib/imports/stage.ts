/**
 * Staging an import (docs/plans/imports.md): read the source, plan it against
 * what the person can see, and write the plan to the journal as a staged
 * import. Nothing in the workspace changes until Apply.
 *
 * Every file is someone else's: read under the caps here and in
 * notion/export.ts (size, unpacked size, entries, path depth, nesting), and
 * its text cleaned (sanitize.ts) before it becomes a body or a description.
 */
import JSZip from 'jszip'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsv, readXlsx, type Sheet } from '@/lib/crm/import/sources/spreadsheet'
import { loadLinearSyncState } from '@/lib/tasks/linear-config'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { listTeams as listLinearTeams } from '@/lib/integrations/linear-api'
import { uploadStoragePath } from './assets'
import { listTeams, loadMatchContext, teamStates, workspaceLabels, workspaceMembers, workspaceProjects } from './context'
import { alreadyImported, stageImport, type WorkImport } from './journal'
import { planLinearImport, type LinearTeamPlan } from './linear/plan'
import { readTeamIssues } from './linear/read'
import { readNotionExport, NOTION_LIMITS } from './notion/export'
import { planNotionImport } from './notion/plan'
import { sanitizeImportedMarkdown } from './sanitize'
import { checkMapping, guessMapping, type TaskField } from './tasks/columns'
import { planTaskImport, TASK_IMPORT_MAX_ROWS } from './tasks/plan'
import type { ActionRecord, ImportPlan } from './types'

export type Staged = { ok: true; imp: WorkImport } | { ok: false; error: string; status?: number }

export interface Who {
  db: SupabaseClient
  svc: SupabaseClient
  workspaceId: string
  userId: string
  memberId: string
}

/** The largest task file read. */
export const TASK_FILE_MAX_BYTES = 5 * 1024 * 1024
/** An .xlsx is a zip: the most it may unpack to. */
const XLSX_MAX_UNPACKED = 50 * 1024 * 1024
/** The most columns read from a task file. */
const MAX_COLUMNS = 60
/** The longest cell kept. */
const MAX_CELL = 20_000

// ── Task CSV ─────────────────────────────────────────────────────────────────

/** A task file as a sheet: CSV (any delimiter) or the first sheet of an .xlsx. */
export async function readTaskFile(bytes: Uint8Array, fileName: string): Promise<{ ok: true; sheet: Sheet } | { ok: false; error: string }> {
  if (bytes.byteLength > TASK_FILE_MAX_BYTES) return { ok: false, error: 'That file is over 5 MB. Split it and import each part.' }
  const lower = fileName.toLowerCase()
  let sheet: Sheet
  try {
    if (lower.endsWith('.xlsx')) {
      const zip = await JSZip.loadAsync(bytes)
      let unpacked = 0
      for (const f of Object.values(zip.files)) unpacked += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
      if (unpacked > XLSX_MAX_UNPACKED) return { ok: false, error: 'That workbook is too big unpacked. Save the sheet as a CSV and import that.' }
      sheet = await readXlsx(bytes)
    } else if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      sheet = parseCsv(new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''))
    } else return { ok: false, error: 'Send a .csv or .xlsx file.' }
  } catch {
    return { ok: false, error: 'That file could not be read as a spreadsheet.' }
  }
  if (!sheet.headers.length) return { ok: false, error: 'The file has no header row.' }
  if (sheet.headers.length > MAX_COLUMNS) return { ok: false, error: `A file brings in at most ${MAX_COLUMNS} columns.` }
  sheet = { ...sheet, headers: sheet.headers.map((h) => h.slice(0, 120)), rows: sheet.rows.map((r) => r.slice(0, sheet.headers.length).map((c) => (c ?? '').slice(0, MAX_CELL))) }
  if (!sheet.rows.length) return { ok: false, error: 'The file has a header but no rows.' }
  return { ok: true, sheet }
}

/** What the mapping step shows: the columns, a guess for each, and a few sample values. */
export function describeSheet(sheet: Sheet) {
  return {
    headers: sheet.headers,
    mapping: guessMapping(sheet.headers),
    samples: sheet.headers.map((_, i) => sheet.rows.slice(0, 50).map((r) => (r[i] ?? '').trim()).filter(Boolean).slice(0, 3).map((v) => v.slice(0, 80))),
    rows: sheet.rows.length,
    over: Math.max(0, sheet.rows.length - TASK_IMPORT_MAX_ROWS),
  }
}

/** Clean every description an import carries (someone else's text). */
function cleanDescriptions(plan: ImportPlan): ImportPlan {
  for (const item of plan.items) {
    if (item.record.kind === 'action' && item.record.description) {
      const a = item.record as ActionRecord
      a.description = sanitizeImportedMarkdown(a.description!) || null
    }
  }
  return plan
}

async function ownTeam(who: Who, teamId: string): Promise<boolean> {
  return (await listTeams(who.db, who.workspaceId, who.memberId)).some((t) => t.id === teamId)
}

export async function stageTaskCsv(
  who: Who,
  input: { bytes: Uint8Array; fileName: string; mapping: unknown[]; teamId: string; projectId?: string | null },
): Promise<Staged> {
  const read = await readTaskFile(input.bytes, input.fileName)
  if (!read.ok) return read
  const mapping = checkMapping(input.mapping, read.sheet.headers.length)
  if (!mapping.ok) return mapping
  if (!(await ownTeam(who, input.teamId))) return { ok: false, error: 'Choose a team of this workspace.' }
  const context = await loadMatchContext(who.db, who.svc, who.workspaceId, input.teamId)
  if (!context.states.length) return { ok: false, error: 'That team has no statuses to put tasks in.' }
  if (input.projectId && !context.projects.some((p) => p.id === input.projectId)) return { ok: false, error: 'Choose a project of this workspace.' }
  const plan = cleanDescriptions(planTaskImport({ headers: read.sheet.headers, rows: read.sheet.rows, mapping: mapping.mapping as TaskField[], context, projectId: input.projectId ?? null }))
  if (!plan.counts.action) return { ok: false, error: 'No row has a title to import.' }
  const imp = await stageImport(who.svc, {
    workspaceId: who.workspaceId,
    userId: who.userId,
    memberId: who.memberId,
    source: 'task_csv',
    label: input.fileName.replace(/[\r\n]+/g, ' ').slice(0, 200),
    destination: { team_id: input.teamId, project_id: input.projectId ?? null },
    plan,
  })
  return { ok: true, imp }
}

// ── Notion ───────────────────────────────────────────────────────────────────

export async function stageNotion(
  who: Who,
  input: { bytes: Uint8Array; fileName: string; visibility: 'workspace' | 'private'; parentFolderId?: string | null; folderName?: string | null },
): Promise<Staged> {
  if (input.bytes.byteLength > NOTION_LIMITS.zipBytes) return { ok: false, error: 'That file is over 50 MB. Export a smaller part of the workspace.', status: 413 }
  if (input.parentFolderId) {
    const { data } = await who.db.from('drive_folder').select('id').eq('id', input.parentFolderId).eq('workspace_id', who.workspaceId).maybeSingle()
    if (!data) return { ok: false, error: 'Choose a folder of this workspace.' }
  }
  const read = await readNotionExport(input.bytes)
  if (!read.ok) return read
  const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const plan = planNotionImport(read.export, {
    folderName: input.folderName?.trim().slice(0, 200) || `Notion import, ${day}`,
    parentFolderId: input.parentFolderId ?? null,
    visibility: input.visibility,
  })
  const imp = await stageImport(who.svc, {
    workspaceId: who.workspaceId,
    userId: who.userId,
    memberId: who.memberId,
    source: 'notion',
    label: input.fileName.replace(/[\r\n]+/g, ' ').slice(0, 200),
    destination: { visibility: input.visibility, parent_folder_id: input.parentFolderId ?? null },
    plan,
  })
  if (plan.counts.asset) {
    // The export waits in the importer's own folder for Apply to upload its files.
    const { error } = await who.svc.storage.from('attachments').upload(uploadStoragePath(who.userId, imp.id), input.bytes, { contentType: 'application/zip', upsert: true })
    if (error) {
      await who.svc.from('work_import').delete().eq('id', imp.id)
      return { ok: false, error: `The export could not be kept for the import: ${error.message}` }
    }
  }
  return { ok: true, imp }
}

// ── Linear ───────────────────────────────────────────────────────────────────

/**
 * The workspace's Linear connection, for the person who connected it. An
 * import reads Linear as its token's owner, so only they may run one: anyone
 * else would see what that person's Linear account sees.
 */
export async function linearTokenFor(who: Pick<Who, 'workspaceId' | 'userId'>): Promise<{ ok: true; token: string } | { ok: false; error: string; code: 'not_connected' | 'not_yours' | 'expired' }> {
  const state = await loadLinearSyncState(who.workspaceId)
  if (!state) return { ok: false, code: 'not_connected', error: 'Linear isn’t connected here. Connect it in Settings › Connectors › Linear.' }
  if (state.userId !== who.userId) return { ok: false, code: 'not_yours', error: 'Only the person who connected Linear can import from it.' }
  const tok = await getValidTokenForAccount(state.accountId)
  if (!tok) return { ok: false, code: 'expired', error: 'The Linear connection has expired. Reconnect it in Settings › Connectors › Linear.' }
  return { ok: true, token: tok.token }
}

export async function linearTeamsFor(who: Who): Promise<{ ok: true; linear: Array<{ id: string; key: string; name: string }>; ours: Awaited<ReturnType<typeof listTeams>> } | { ok: false; error: string; code?: string }> {
  const tok = await linearTokenFor(who)
  if (!tok.ok) return tok
  const [linear, ours] = await Promise.all([listLinearTeams(tok.token), listTeams(who.db, who.workspaceId, who.memberId)])
  return { ok: true, linear: linear.map((t) => ({ id: t.id, key: t.key ?? '', name: t.name ?? 'Linear team' })), ours }
}

export async function stageLinear(
  who: Who,
  input: { teams: Array<{ linearTeamId: string; teamId: string }>; includeClosed: boolean; createStates: boolean },
): Promise<Staged> {
  if (!input.teams.length || input.teams.length > 10) return { ok: false, error: 'Choose one to ten Linear teams.' }
  const tok = await linearTokenFor(who)
  if (!tok.ok) return { ok: false, error: tok.error }
  const ours = await listTeams(who.db, who.workspaceId, who.memberId)
  const linear = await listLinearTeams(tok.token)
  const teams: LinearTeamPlan[] = []
  let left = 5000
  for (const t of input.teams) {
    const mine = ours.find((o) => o.id === t.teamId)
    const theirs = linear.find((l) => l.id === t.linearTeamId)
    if (!mine) return { ok: false, error: 'Choose a team of this workspace for each Linear team.' }
    if (!theirs) return { ok: false, error: 'That Linear team isn’t one the connection can read.' }
    if (left <= 0) break
    const read = await readTeamIssues(tok.token, theirs.id, { includeClosed: input.includeClosed, max: left })
    left -= read.issues.length
    teams.push({ teamId: mine.id, linearTeamName: theirs.name ?? 'Linear', issues: read.issues, states: await teamStates(who.db, mine.id), truncated: read.truncated })
  }
  const ids = teams.flatMap((t) => t.issues.map((i) => i.id))
  const [members, labels, projects, seen] = await Promise.all([
    workspaceMembers(who.db, who.svc, who.workspaceId),
    workspaceLabels(who.db, who.workspaceId),
    workspaceProjects(who.db, who.workspaceId),
    alreadyImported(who.svc, who.workspaceId, 'action', ids),
  ])
  const plan = cleanDescriptions(planLinearImport({ teams, members, labels, projects, createStates: input.createStates, alreadyImported: seen }))
  if (!plan.counts.action) return { ok: false, error: ids.length ? 'Every issue there was imported before.' : 'Those Linear teams have no issues to import.' }
  const imp = await stageImport(who.svc, {
    workspaceId: who.workspaceId,
    userId: who.userId,
    memberId: who.memberId,
    source: 'linear',
    label: teams.map((t) => t.linearTeamName).join(', ').slice(0, 200),
    destination: { teams: input.teams.map((t) => ({ linear_team_id: t.linearTeamId, team_id: t.teamId })), include_closed: input.includeClosed, create_states: input.createStates },
    plan,
  })
  return { ok: true, imp }
}
