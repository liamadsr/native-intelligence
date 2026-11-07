import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'

export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { env } = await request.json()

  if (env !== 'development' && env !== 'production') {
    return NextResponse.json({ error: 'Invalid environment' }, { status: 400 })
  }

  if (env === 'production' && (!process.env.PROD_SUPABASE_URL || !process.env.PROD_SUPABASE_SERVICE_ROLE_KEY)) {
    return NextResponse.json({ error: 'Production credentials not configured' }, { status: 400 })
  }

  const response = NextResponse.json({ env })
  response.cookies.set('admin_env', env, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })

  return response
}
