import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { verifyUnsubscribeToken } from '@/lib/email'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { email, token, rating, message } = body

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    if (!token || !verifyUnsubscribeToken(email, token)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 403 })
    }

    const supabase = getServiceClient()

    // Update feedback on the early_access record
    const { error } = await supabase
      .from('early_access')
      .update({
        feedback: {
          rating: rating ?? null,
          message: message ?? null,
          submitted_at: new Date().toISOString(),
        },
      })
      .eq('email', email.toLowerCase().trim())

    if (error) {
      console.error('Feedback save error:', error.message)
      return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 })
    }

    const posthog = getPostHogServerClient()
    posthog?.capture({
      distinctId: email,
      event: 'feedback_submitted',
      properties: {
        rating: rating ?? null,
        has_message: !!message,
        ...serverDefaultProperties,
      },
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
