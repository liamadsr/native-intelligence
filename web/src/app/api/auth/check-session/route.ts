import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { APP_PAGE_ORIGINS } from '@/lib/app-url'

const ALLOWED_ORIGINS = new Set([
  process.env.NEXT_PUBLIC_APP_URL,
  ...APP_PAGE_ORIGINS,
  'tauri://localhost', // Tauri desktop app (macOS/Linux)
  'https://tauri.localhost', // Tauri desktop app (Windows)
  'http://localhost:3000', // Local dev
].filter(Boolean))

function getCorsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || ''
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : ''
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(request) })
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return NextResponse.json({ authenticated: !!user }, { headers: getCorsHeaders(request) })
}
