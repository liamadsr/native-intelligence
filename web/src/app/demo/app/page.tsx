import { Suspense } from 'react'
import DemoAppScreen from './screen'

/**
 * The real app on the made-up demo workspace, one screen per `?screen=`
 * (components/demo/demo-app.tsx). Public and signed out: every request the
 * app makes is answered in the browser from a recording. The public site
 * shows it in a frame (next.config.mjs lets only our own pages frame /demo).
 */
export const metadata = { title: 'Native Intelligence', robots: { index: false, follow: false } }

export default function DemoAppPage() {
  return (
    <Suspense>
      <DemoAppScreen />
    </Suspense>
  )
}
