'use client'

/**
 * The landing demos, loaded only as they near the viewport.
 *
 * The demos draw the product's own components (the HUD, an agent's plan and
 * reply, …), which are far heavier than the
 * marketing page around them. So none of that code is in the page's first
 * load: each demo is its own chunk (next/dynamic, client only), fetched once
 * its slot comes within a screen or so of the viewport, with a quiet
 * placeholder of the demo's own height until then so nothing shifts.
 */
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { cn } from '@/lib/utils'
import type { LiveAgentScenario } from './live-agent-demo'

/** A slot that mounts `children` once it is within `margin` of the viewport. */
function NearViewport({ height, children, className }: { height: number; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true)
        io.disconnect()
      }
    }, { rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near])
  return (
    <div ref={ref} className={cn('w-full', className)} style={near ? undefined : { minHeight: height }}>
      {near ? children : null}
    </div>
  )
}

function lazyDemo<P extends object>(load: () => Promise<ComponentType<P>>, height: number) {
  const Demo = dynamic(load, {
    ssr: false,
    loading: () => <div aria-hidden className="w-full rounded-[28px] bg-foreground/[0.03]" style={{ height }} />,
  })
  function LazyDemo(props: P) {
    return (
      <NearViewport height={height}>
        <Demo {...props} />
      </NearViewport>
    )
  }
  return LazyDemo
}

export const HudTipsDemo = lazyDemo(() => import('./hud-tips-demo').then((m) => m.HudTipsDemo), 500)
export const LiveAgentDemo = lazyDemo<{ scenario?: LiveAgentScenario; tools?: boolean }>(() => import('./live-agent-demo').then((m) => m.LiveAgentDemo), 560)
export const ContextPackageDemo = lazyDemo(() => import('./context-package-demo').then((m) => m.ContextPackageDemo), 480)
export const ExecutionDemo = lazyDemo(() => import('./execution-demo').then((m) => m.ExecutionDemo), 510)
export const IntelligenceLoopDemo = lazyDemo(() => import('./intelligence-loop-demo').then((m) => m.IntelligenceLoopDemo), 420)
