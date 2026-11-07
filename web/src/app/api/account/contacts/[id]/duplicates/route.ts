import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { findDuplicateCandidates } from '@/lib/crm/contact-dedup'
import { NextResponse, type NextRequest } from 'next/server'

// Likely duplicates of a single contact, for the "Possible duplicates" panel.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  // Membership is enforced by RLS on the underlying contact read; confirm the
  // contact is visible to the caller in this workspace before scanning.
  const { data: contact } = await supabase
    .from('contact')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

  const candidates = await findDuplicateCandidates(workspaceId, id)

  return NextResponse.json({
    duplicates: candidates.map((d) => ({
      id: d.contact.id,
      full_name: d.contact.full_name,
      email: d.contact.email,
      secondary_emails: d.contact.secondary_emails,
      tier: d.tier,
      match_type: d.matchType,
      score: d.score,
      reasons: d.reasons,
    })),
  })
}
