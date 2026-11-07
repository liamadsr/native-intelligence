import { createClient as createSupabaseClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { ADMIN_EMAILS, isAdminEmail } from './admin-emails'

export type AdminEnv = 'development' | 'production'

const SUPABASE_CONFIGS = {
  development: {
    url: () => process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey: () => process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },
  production: {
    url: () => process.env.PROD_SUPABASE_URL!,
    serviceRoleKey: () => process.env.PROD_SUPABASE_SERVICE_ROLE_KEY!,
  },
} as const

/** The admins, by address (./admin-emails.ts, a leaf billing reads too). */
export { ADMIN_EMAILS }

/**
 * Whether admin also needs a second factor: a session at AAL2 (Supabase MFA).
 * Off because no admin has a factor enrolled yet (PROD, 10-31), and on it
 * would lock them out; there is no enrol or challenge screen either. Turn it
 * on once every ADMIN_EMAILS account has a verified factor.
 */
export const ADMIN_REQUIRES_MFA: boolean = false

/**
 * Checks whether the given email belongs to an authorized admin.
 */
export function isAuthorizedAdmin(email: string | undefined): boolean {
  return isAdminEmail(email)
}

/**
 * Whether this session's assurance is enough for admin: always while
 * ADMIN_REQUIRES_MFA is off, else AAL2 (a verified second factor this
 * session). `jwt` for a bearer token; the cookie session otherwise. A failed
 * read is not enough.
 */
export async function hasAdminAssurance(
  supabase: SupabaseClient,
  opts: { jwt?: string; required?: boolean } = {},
): Promise<boolean> {
  if (!(opts.required ?? ADMIN_REQUIRES_MFA)) return true
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel(opts.jwt)
    return !error && data?.currentLevel === 'aal2'
  } catch {
    return false
  }
}

/**
 * Returns a service-role Supabase client using the default env vars
 * (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
 * Locally these point to dev; on Vercel they point to prod.
 */
export function getServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Validates that the current request is from an authenticated admin
 * (ADMIN_EMAILS, at the assurance hasAdminAssurance asks for).
 * Returns the user if valid, throws a Response if not.
 */
export async function requireAdmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isAuthorizedAdmin(user.email) || !(await hasAdminAssurance(supabase))) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return user
}

/**
 * Reads the admin environment from the cookie. Defaults to 'development'.
 */
export async function getAdminEnv(): Promise<AdminEnv> {
  const cookieStore = await cookies()
  const env = cookieStore.get('admin_env')?.value
  return env === 'production' ? 'production' : 'development'
}

/**
 * Returns a Supabase service-role client pointing at the selected admin environment.
 * Falls back to development if the selected environment's credentials are not configured.
 */
export async function getAdminServiceClient() {
  let env = await getAdminEnv()
  const config = SUPABASE_CONFIGS[env]

  // Fall back to development if prod credentials aren't set
  if (!config.url() || !config.serviceRoleKey()) {
    env = 'development'
    const fallback = SUPABASE_CONFIGS.development
    return createSupabaseClient(fallback.url(), fallback.serviceRoleKey())
  }

  return createSupabaseClient(config.url(), config.serviceRoleKey())
}

/**
 * Fetches every auth user by paginating through supabase.auth.admin.listUsers().
 *
 * The Supabase admin API defaults to 50 users per page and callers that don't
 * paginate silently truncate at that limit. Use this helper anywhere you need
 * the full set of users.
 */
export async function listAllAuthUsers(
  supabase: SupabaseClient,
  { perPage = 1000 }: { perPage?: number } = {},
): Promise<User[]> {
  const all: User[] = []
  let page = 1

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw error

    const users = data?.users ?? []
    all.push(...users)

    if (users.length < perPage) break
    page += 1
  }

  return all
}
