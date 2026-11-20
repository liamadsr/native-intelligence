'use client'

/**
 * A made-up workspace around one of the app's real screens: while this is on
 * the page, the screen's requests are answered from `snapshot`
 * (lib/demo/demo-fetch.ts). The screen mounts only once its requests have
 * somewhere to go, and the demo is a picture, so it takes no input (`inert`).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { installDemoFetch, type DemoSnapshot } from '@/lib/demo/demo-fetch'

export function DemoWorkspace({ snapshot, children, className }: { snapshot: DemoSnapshot; children: ReactNode; className?: string }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const remove = installDemoFetch(snapshot)
    setReady(true)
    return () => {
      setReady(false)
      remove()
    }
  }, [snapshot])
  return (
    <div aria-hidden inert className={className}>
      {ready ? children : null}
    </div>
  )
}
