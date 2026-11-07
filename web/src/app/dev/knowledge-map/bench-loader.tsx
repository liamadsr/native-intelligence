'use client'

import dynamic from 'next/dynamic'

/**
 * `ssr: false` is only legal in a client module, so the server page imports
 * this one-line wrapper instead of calling `dynamic` itself — the same shape
 * `views/knowledge-view.tsx` uses to load the legacy graph.
 *
 * The bench must not server-render at all: it builds typed arrays for up to a
 * million nodes and mounts a WebGL2 canvas.
 */
const KnowledgeMapBench = dynamic(() => import('./bench'), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center text-sm text-muted-foreground">
      Loading benchmark…
    </div>
  ),
})

export default function KnowledgeMapBenchLoader() {
  return <KnowledgeMapBench />
}
