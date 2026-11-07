import { notFound } from 'next/navigation'
import LocalAgentDevLoader from './loader'

/**
 * Local agents dev page (L0 spike) — DEV ONLY.
 *
 * Drives our eve agent on the Mac through the desktop's local_agent_*
 * commands (L0 contract §5): grant a folder through the native picker, start a
 * job, watch it stream, steer it, stop it, quit and relaunch, resume. Useful
 * only in a debug desktop build, so it lives outside /account like the
 * knowledge-map bench: `notFound()` in production keeps it out of the shipped
 * app; `robots: noindex` is belt and braces for any preview deployment.
 */
export const metadata = {
  robots: { index: false },
}

export default function LocalAgentDevPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return (
    <main className="min-h-dvh w-full">
      <LocalAgentDevLoader />
    </main>
  )
}
