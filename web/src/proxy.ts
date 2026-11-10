import { createServerClient } from '@supabase/ssr'
import { authCookieOptions } from '@/lib/supabase/project'
import { createClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { hasAdminAssurance, isAuthorizedAdmin } from '@/lib/admin'
import { isDeviceToken, resolveDeviceToken } from '@/lib/device-tokens'
import { OLD_DOMAIN_FORWARD_SETTING, oldDomainForward } from '@/lib/old-domain-forward'

/** Reasons the forward could not run although its setting asks for it, each logged once. */
const forwardBlockedLogged = new Set<string>()

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // People who open a page on the old domain go to the current one, when
  // NI_FORWARD_OLD_DOMAIN asks for it (src/lib/old-domain-forward.ts). First,
  // so an admin or account page moves before anything reads its session.
  const forward = oldDomainForward(request)
  if (forward.forward) {
    const response = NextResponse.redirect(forward.location, forward.status)
    // A temporary forward must stay one: no cache may keep it.
    if (forward.status === 307) response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
  if (forward.blocked && !forwardBlockedLogged.has(forward.reason)) {
    forwardBlockedLogged.add(forward.reason)
    console.warn(`[old-domain-forward] ${OLD_DOMAIN_FORWARD_SETTING} is set, but ${forward.reason}: not forwarding`)
  }

  // Don't protect public auth pages
  if (
    pathname === '/admin/login' ||
    pathname.startsWith('/admin/auth/')
  ) {
    return NextResponse.next()
  }

  const isAdminRoute =
    pathname.startsWith('/admin') || pathname.startsWith('/api/admin')
  const isAccountRoute =
    pathname.startsWith('/account') || pathname.startsWith('/api/account')

  // Only protect admin and account routes
  if (!isAdminRoute && !isAccountRoute) {
    return NextResponse.next()
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The same cookie name every other client uses (src/lib/supabase/project.ts).
      ...authCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const cookieResult = await supabase.auth.getUser()
  let user: User | null = cookieResult.data.user
  /** The Supabase access token a bearer request signed in with (its assurance is read from it). */
  let bearerJwt: string | undefined

  // Non-browser clients (hardware devices, desktop app, MCP) authenticate with
  // an `Authorization: Bearer <token>` header, not a cookie. The cookie-only
  // getUser() above sees no session for them, so check the header before
  // bouncing the request. Two token kinds:
  //   - Native Intelligence device token (`nid_…`): opaque, resolved against device_token.
  //   - Supabase access token (`eyJ…`): a JWT, validated via getUser(token).
  // The downstream route's own auth (requireWorkspace / authenticateUser) is
  // the real authority; this proxy just must not block valid Bearer requests.
  if (!user) {
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      if (isDeviceToken(token)) {
        const resolved = await resolveDeviceToken(token)
        if (resolved) {
          // Synthesize the minimal user the checks below read (id/email).
          user = { id: resolved.userId } as User
        }
      } else {
        const bearerClient = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        )
        const { data } = await bearerClient.auth.getUser(token)
        if (data.user) {
          user = data.user
          bearerJwt = token
        }
      }
    }
  }

  const isApiRoute =
    pathname.startsWith('/api/admin') || pathname.startsWith('/api/account')
  const loginPath = isAdminRoute ? '/admin/login' : '/login'

  // No session → redirect to login (UI) or return 401 (API)
  if (!user) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const url = request.nextUrl.clone()
    url.pathname = loginPath
    return NextResponse.redirect(url)
  }

  // Admin routes require an ADMIN_EMAILS account, at the assurance admin
  // asks for (lib/admin.ts) — redirect non-admins to /account
  if (isAdminRoute && !(isAuthorizedAdmin(user.email) && (await hasAdminAssurance(supabase, { jwt: bearerJwt })))) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const url = request.nextUrl.clone()
    url.pathname = '/account'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
    '/account/:path*',
    '/api/account/:path*',
    // The old domain's page loads, for the forward (src/lib/old-domain-forward.ts,
    // which decides; this only keeps the proxy from running for anything else):
    // dial8.ai or www.dial8.ai, and not _next, api, eve, the analytics rewrite or
    // a file. A literal, because Next reads it at build time; a test pins it to
    // FORWARD_FROM_DOMAINS.
    {
      source:
        '/((?!_|api(?:/|$)|eve(?:/|$)|ingest(?:/|$)|.*\\.(?:avif|css|gif|ico|jpe?g|js|json|map|mjs|mp3|mp4|onnx|pdf|png|svg|ttf|txt|wasm|wav|webm|webmanifest|webp|woff2?|xml)$).*)',
      has: [{ type: 'host', value: '(?:www\\.)?dial8\\.ai' }],
    },
  ],
}
