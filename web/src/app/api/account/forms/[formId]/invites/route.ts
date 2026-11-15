import type { NextRequest } from 'next/server'
import { inviteToForm } from '@/lib/forms/manage'
import { runManage } from '@/lib/forms/manage-route'

/**
 * POST { invites: [{ label?, contact_id? }], expires_in_days? }: personal
 * links to an invited form, each storing one submission. Answers the links
 * once; sending them is the person's (or the agent's) own step.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ formId: string }> }) {
  const { formId } = await params
  return runManage(request, (ctx, body) => inviteToForm(ctx, formId, body))
}
