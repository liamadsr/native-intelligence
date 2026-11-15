import type { NextRequest } from 'next/server'
import { patchForm } from '@/lib/forms/manage'
import { runManage } from '@/lib/forms/manage-route'

/**
 * PATCH { name?, description?, submit_label?, thanks?, fields?, access?,
 * allowed_origins?, bot_check?, active?, new_link? }: change a form (fields
 * by column key). With new_link: true, answers the new `url`, `page_url` and
 * (a public form) `embed` once; the old link stops at once.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ formId: string }> }) {
  const { formId } = await params
  return runManage(request, (ctx, body) => patchForm(ctx, formId, body))
}
