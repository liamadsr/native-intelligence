'use client'

import dynamic from 'next/dynamic'

/** Rendered after mount only: the fixture stubs `fetch` and fills the Code view's store in the browser. */
const CodeViewFixture = dynamic(() => import('./code-view-fixture'), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading…</div>,
})

export default function CodeViewFixtureLoader() {
  return <CodeViewFixture />
}
