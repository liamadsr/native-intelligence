'use client'
/** The desktop pieces the Mac exit uses, in one place so its tests can stand them in. */
export { getThisWebviewLabel, tauriBridge, type BrowserExitStatus } from '@/lib/tauri-bridge'
export { isDesktopApp as isDesktopAppForExit } from '@/lib/platform'
import { createClient } from '@/lib/supabase/client'

/** This window's session token: the app serves only the account it holds the session of (browser_exit.rs). */
export async function sessionAccessToken(): Promise<string | null> {
  const { data } = await createClient().auth.getSession()
  return data.session?.access_token ?? null
}
