import { getServiceClient } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { NextResponse } from 'next/server'

// Simple in-memory rate limiting (resets on server restart)
// For production, consider using Redis or Upstash
const rateLimitMap = new Map<string, { count: number; resetTime: number }>()
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5 // 5 requests per minute per IP

function getRateLimitKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown'
  return ip
}

function isRateLimited(key: string): boolean {
  const now = Date.now()
  const record = rateLimitMap.get(key)

  if (!record || now > record.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true
  }

  record.count++
  return false
}

export async function POST(request: Request) {
  try {
    // Rate limiting
    const rateLimitKey = getRateLimitKey(request)
    if (isRateLimited(rateLimitKey)) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
      )
    }

    const body = await request.json()
    const { email, honeypot, source: requestSource } = body

    // Honeypot check - if this field is filled, it's likely a bot
    if (honeypot) {
      // Silently reject but return success to not tip off bots
      return NextResponse.json({ success: true, message: 'Successfully joined the waitlist' })
    }

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    // Length check
    if (email.length > 254) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    const sanitizedEmail = email.toLowerCase().trim().slice(0, 254)

    const supabase = getServiceClient()

    const sanitizedSource = typeof requestSource === 'string' ? requestSource.slice(0, 50) : 'website'

    const { error } = await supabase.from('early_access').insert({
      email: sanitizedEmail,
      source: sanitizedSource,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    })

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'This email is already on the waitlist' },
          { status: 409 }
        )
      }
      console.error('Supabase error:', error)
      return NextResponse.json({ error: 'Failed to join waitlist' }, { status: 500 })
    }

    // Track server-side event and set email + discovery source on the person profile.
    // $set_once preserves the original signup_source if the person signs up again.
    const posthog = getPostHogServerClient()
    posthog?.capture({
      distinctId: sanitizedEmail,
      event: 'waitlist_signup',
      properties: {
        source: sanitizedSource,
        ...serverDefaultProperties,
        $set: { email: sanitizedEmail },
        $set_once: { signup_source: sanitizedSource },
      },
    })

    return NextResponse.json({ success: true, message: 'Successfully joined the waitlist' })
  } catch (error) {
    console.error('Early access error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
