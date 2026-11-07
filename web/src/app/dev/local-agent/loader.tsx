'use client'

import dynamic from 'next/dynamic'

/**
 * `ssr: false` is only legal in a client module, so the server page imports
 * this wrapper. The page renders only after mount: `isDesktopApp()` reads
 * `window`, so a server render could never agree with the client's.
 */
const LocalAgentDev = dynamic(() => import('./local-agent-dev'), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading…</div>,
})

export default function LocalAgentDevLoader() {
  return <LocalAgentDev />
}
