'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Catches render errors inside the dashboard subtree so a transient render
 * failure during a workspace transition (e.g. deletion, hard-navigation,
 * provider unmount) doesn't show the Next.js full-page error overlay.
 *
 * Production: render nothing for a moment and re-render the subtree — a
 * transient failure recovers on the retry. The boundary sits in the persistent
 * dashboard layout and never remounts, so it must reset itself: after a few
 * failed retries it shows a small "Try again / Reload" fallback instead of
 * leaving the app blank until a hard reload.
 * Dev: log the error to the console so the underlying bug is still visible.
 */
type Props = { children: ReactNode }
type State = { hasError: boolean; retries: number }

const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 500
const RESET_AFTER_MS = 10_000

export class DashboardErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, retries: 0 }
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resetTimer: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the error in the console so it's discoverable in dev even when
    // we swallow it visually.
    console.error('[DashboardErrorBoundary]', error, info.componentStack)
    if (this.state.retries < MAX_AUTO_RETRIES) {
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.setState((s) => ({ hasError: false, retries: s.retries + 1 }))
      }, RETRY_DELAY_MS)
    }
  }

  componentDidUpdate() {
    // A retry that has rendered cleanly for a while restores the auto-retry
    // budget, so a transient error much later in a long session still gets it.
    if (!this.state.hasError && this.state.retries > 0 && !this.resetTimer) {
      this.resetTimer = setTimeout(() => {
        this.resetTimer = null
        if (!this.state.hasError) this.setState({ retries: 0 })
      }, RESET_AFTER_MS)
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.resetTimer) clearTimeout(this.resetTimer)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    if (this.state.retries < MAX_AUTO_RETRIES) return null
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Something went wrong.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => this.setState({ hasError: false, retries: 0 })}>
            Try again
          </Button>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }
}
