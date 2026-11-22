/**
 * POST /api/account/crm/export { entity_type: 'company' | 'contact' }: the
 * companies or contacts the person can see, as CSV, with their custom fields
 * and (companies) the stage, owner and revenue (migration 679).
 *
 * Read with the person's own client, so the contact and company row policies
 * decide what is in it, exactly as for the list (058, 059, 493). Merged
 * contacts are left out. Pipelines export as tables (/api/account/tables/[id]/export).
 */
import type { NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { listCustomFieldDefinitions } from '@/lib/crm/custom-fields'
import { fieldValueLabels } from '@/lib/crm/custom-field-references'
import {
  companiesCsv,
  contactsCsv,
  crmExportFileName,
  CRM_EXPORT_MAX_ROWS,
  type ExportCompanyRow,
  type ExportContactRow,
} from '@/lib/crm/crm-csv'

const PAGE = 1000

interface ExportQuery {
  eq: (c: string, v: string) => ExportQuery
  is: (c: string, v: null) => ExportQuery
  order: (c: string, o: { ascending: boolean }) => ExportQuery
  range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
}

const COMPANY_SELECT =
  'id, name, domain, website, industry, employee_count_range, phone, contact_email, address, city, state, country, tags, created_at, revenue, custom_fields, stage:company_stage!stage_id(name), owner:member!owner_member_id(display_name)'
const CONTACT_SELECT =
  'id, company_id, full_name, email, phone, job_title, relationship_type, relationship_strength, last_interaction_at, tags, created_at, custom_fields, company:company!company_id(name, domain)'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const body = (await request.json().catch(() => ({}))) as { entity_type?: unknown }
  const kind = body.entity_type
  if (kind !== 'company' && kind !== 'contact') return badRequest('Export companies or contacts.')
  try {
    const rows: Array<Record<string, unknown>> = []
    for (let from = 0; from < CRM_EXPORT_MAX_ROWS; from += PAGE) {
      // Typed loosely: the two kinds' selects make a union too wide for the checker.
      const table = supabase.from(kind) as unknown as { select: (s: string) => ExportQuery }
      let q = table.select(kind === 'company' ? COMPANY_SELECT : CONTACT_SELECT).eq('workspace_id', workspaceId)
      if (kind === 'contact') q = q.is('merged_into_contact_id', null)
      const { data, error } = await q
        .order(kind === 'company' ? 'name' : 'full_name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, Math.min(from + PAGE, CRM_EXPORT_MAX_ROWS) - 1)
      if (error) return serverError(error.message)
      rows.push(...((data ?? []) as unknown as Array<Record<string, unknown>>))
      if (!data || data.length < PAGE) break
    }
    const defs = await listCustomFieldDefinitions(supabase, workspaceId, kind)
    const labels = await fieldValueLabels(supabase, workspaceId, defs, rows.map((r) => r.custom_fields as Record<string, unknown> | null))

    let csv: string
    if (kind === 'company') {
      // The last interaction with any of its people this person can see (RLS read).
      const ids = rows.map((r) => r.id as string)
      const last = new Map<string, string>()
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase
          .from('contact')
          .select('company_id, last_interaction_at')
          .eq('workspace_id', workspaceId)
          .is('merged_into_contact_id', null)
          .in('company_id', ids.slice(i, i + 200))
          .not('last_interaction_at', 'is', null)
        for (const c of (data ?? []) as Array<{ company_id: string; last_interaction_at: string }>) {
          if (!last.has(c.company_id) || c.last_interaction_at > last.get(c.company_id)!) last.set(c.company_id, c.last_interaction_at)
        }
      }
      csv = companiesCsv(rows.map((r) => ({ ...(r as unknown as ExportCompanyRow), last_interaction_at: last.get(r.id as string) ?? null })), defs, labels)
    } else {
      csv = contactsCsv(rows as unknown as ExportContactRow[], defs, labels)
    }
    const name = crmExportFileName(kind)
    return new Response(`﻿${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        ...(rows.length >= CRM_EXPORT_MAX_ROWS ? { 'X-Export-Truncated': '1' } : {}),
      },
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Export failed')
  }
}
