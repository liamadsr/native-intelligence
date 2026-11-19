import type { Metadata } from 'next'
import { CallWindowPage } from './call-window-page'

export const metadata: Metadata = {
  title: 'Call',
  robots: { index: false, follow: false },
}

/**
 * The desktop's call window (src-tauri/src/commands/call_window.rs loads
 * {origin}/hud/call into the transparent, always-on-top `call` window): the
 * team call or meeting the person is in, apart from the app's window. What it
 * does and how it talks to the app's windows: src/lib/team-calls/call-window.ts.
 */
export default function Page() {
  return <CallWindowPage />
}
