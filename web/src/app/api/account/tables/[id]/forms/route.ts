import type { NextRequest } from 'next/server'
import { createTableForm, listTableForms } from '@/lib/forms/manage'
import { runManage } from '@/lib/forms/manage-route'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the table's forms (src/lib/forms/manage.ts formForApi), never their links. */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params
  return runManage(null, (ctx) => listTableForms(ctx, id))
}

/**
 * POST { fields: [{ key, label?, required? }], name?, description?,
 * submit_label?, thanks?, access?, allowed_origins?, bot_check? }: make a
 * form on the table. Answers it and, once, its `url`, `page_url` and (a
 * public form) `embed`.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params
  return runManage(request, (ctx, body) => createTableForm(ctx, id, body))
}
