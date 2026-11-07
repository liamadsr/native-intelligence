import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { findOrCreateContact } from '@/lib/crm/contacts'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60

interface AttendeeInput {
  email: string
  fullName: string
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()
  const attendees: AttendeeInput[] = body.attendees

  if (!Array.isArray(attendees) || attendees.length === 0) {
    return NextResponse.json({ error: 'No attendees provided' }, { status: 400 })
  }

  // Cap at 500 to prevent abuse, deduplicate by email
  const seen = new Set<string>()
  const unique: AttendeeInput[] = []
  for (const a of attendees.slice(0, 500)) {
    if (!a.email || !a.fullName) continue
    const email = a.email.trim().toLowerCase()
    // Reject display labels masquerading as emails (attendees with no address).
    if (!email.includes('@')) continue
    if (seen.has(email)) continue
    seen.add(email)
    unique.push({ email, fullName: a.fullName })
  }

  // Check which emails already exist as contacts in one query
  const supabaseAdmin = getServiceClient()
  const { data: existingContacts } = await supabaseAdmin
    .from('contact')
    .select('email')
    .eq('workspace_id', workspaceId)
    .in('email', unique.map((a) => a.email))

  const existingEmails = new Set(
    (existingContacts ?? []).map((c: { email: string }) => c.email.toLowerCase()),
  )

  let created = 0
  let existing = existingEmails.size
  let errors = 0

  // Only create contacts that don't already exist
  const toCreate = unique.filter((a) => !existingEmails.has(a.email))

  for (const attendee of toCreate) {
    try {
      const result = await findOrCreateContact(workspaceId, {
        email: attendee.email,
        fullName: attendee.fullName,
        source: 'calendar_sync',
      })
      if (result) created++
    } catch {
      errors++
    }
  }

  return NextResponse.json({
    created,
    existing,
    total: unique.length,
    errors,
  })
}
