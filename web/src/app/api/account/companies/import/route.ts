/**
 * POST /api/account/companies/import: a companies CSV (multipart `file`, or
 * JSON { csv }). Each row is matched to a company by domain, then by name;
 * a match is updated, anything else is added. The company's stage (by name),
 * owner (a member, by name), revenue (with a currency column or a symbol)
 * and custom fields (by label) are set when their columns are there
 * (migration 679); the other columns fill only what is empty on a match.
 * `dry_run` answers what would happen and writes nothing.
 *
 * Written with the person's own client (the company policies decide); a
 * match the person can't see is left alone and reported, never duplicated.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { parseCsv } from '@/lib/crm/import/sources/spreadsheet'
import { listCustomFieldDefinitions } from '@/lib/crm/custom-fields'
import { listCompanyStages } from '@/lib/crm/company-stages'
import { planCompanyImport, type PlannedCompany } from '@/lib/crm/crm-csv'

const MAX_BYTES = 5 * 1024 * 1024

async function readCsv(request: NextRequest): Promise<{ csv: string; dryRun: boolean } | null> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!file || typeof file === 'string' || file.size > MAX_BYTES) return null
    return { csv: await file.text(), dryRun: form?.get('dry_run') === 'true' }
  }
  const body = (await request.json().catch(() => null)) as { csv?: unknown; dry_run?: unknown } | null
  if (!body || typeof body.csv !== 'string' || body.csv.length > MAX_BYTES) return null
  return { csv: body.csv, dryRun: body.dry_run === true }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, user } = auth
  const input = await readCsv(request)
  if (!input) return badRequest('Send a CSV file (at most 5 MB).')
  try {
    const sheet = parseCsv(input.csv.replace(/^﻿/, ''))
    const [stages, defs, membersRes] = await Promise.all([
      listCompanyStages(supabase, workspaceId),
      listCustomFieldDefinitions(supabase, workspaceId, 'company'),
      supabase.from('member').select('id, display_name').eq('workspace_id', workspaceId),
    ])
    const plan = planCompanyImport(sheet, { stages, members: (membersRes.data ?? []) as Array<{ id: string; display_name: string | null }>, defs })

    // Matches: by domain, then name, in this workspace (the service role only
    // answers "is there one", so a hidden one is never duplicated).
    const svc = getServiceClient()
    const results = { added: 0, updated: 0, skipped: [...plan.skipped], warnings: plan.warnings }
    for (const c of plan.companies) {
      const domain = typeof c.fields.domain === 'string' ? c.fields.domain : null
      const name = String(c.fields.name)
      let match: { id: string } | null = null
      if (domain) match = ((await svc.from('company').select('id').eq('workspace_id', workspaceId).eq('domain', domain).limit(1)).data ?? [])[0] ?? null
      if (!match) match = ((await svc.from('company').select('id').eq('workspace_id', workspaceId).ilike('name', name.replace(/[%_]/g, (m) => `\\${m}`)).limit(1)).data ?? [])[0] ?? null
      if (match) {
        const { data: visible } = await supabase.from('company').select('*').eq('id', match.id).maybeSingle()
        if (!visible) {
          results.skipped.push({ line: c.line, reason: 'A company with that name or domain exists that you can’t see.' })
          continue
        }
        if (input.dryRun) {
          results.updated++
          continue
        }
        const { error } = await supabase.from('company').update(updatesFor(c, visible as Record<string, unknown>)).eq('id', match.id).eq('workspace_id', workspaceId)
        if (error) results.skipped.push({ line: c.line, reason: error.message })
        else results.updated++
        continue
      }
      if (input.dryRun) {
        results.added++
        continue
      }
      const { error } = await supabase.from('company').insert({ workspace_id: workspaceId, ...insertFor(c) })
      if (error) results.skipped.push({ line: c.line, reason: error.message })
      else results.added++
    }
    console.info(`[companies/import] user=${user.id} added=${results.added} updated=${results.updated} skipped=${results.skipped.length}`)
    return NextResponse.json({ dry_run: input.dryRun, ...results, columns: plan.columns.map((c) => ({ header: c.header, to: c.kind === 'field' ? c.target : c.kind === 'custom' ? `custom:${c.key}` : null })) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Import failed')
  }
}

function crmOf(c: PlannedCompany): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (c.stage_id !== undefined) out.stage_id = c.stage_id
  if (c.owner_member_id !== undefined) out.owner_member_id = c.owner_member_id
  if (c.revenue !== undefined) out.revenue = c.revenue
  return out
}

function insertFor(c: PlannedCompany): Record<string, unknown> {
  return { ...c.fields, ...crmOf(c), custom_fields: c.custom_fields }
}

/** On a match: stage, owner, revenue and custom fields as the CSV says; other columns only where empty. */
function updatesFor(c: PlannedCompany, current: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...crmOf(c), updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries(c.fields)) {
    if (k === 'name') continue
    const now = current[k]
    if (now === null || now === undefined || now === '' || (Array.isArray(now) && now.length === 0)) out[k] = v
  }
  if (Object.keys(c.custom_fields).length) out.custom_fields = { ...((current.custom_fields as Record<string, unknown>) ?? {}), ...c.custom_fields }
  return out
}
