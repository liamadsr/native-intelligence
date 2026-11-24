'use client'

/**
 * A crash inside one card stays in that card.
 *
 * Without this, an error thrown while a card renders (a page card's editor, a
 * record panel) reaches the dashboard's boundary
 * (app/account/(dashboard)/dashboard-error-boundary.tsx), which blanks the
 * whole dashboard and mounts it again: the card is gone and the person is
 * back on Home with nothing said. The owner saw exactly that on opening a
 * spreadsheet (11-24), and Sentry had no event for it.
 *
 * Here the card keeps its frame and says it could not open this, with Try
 * again (which mounts the card's body afresh). Every catch is reported to
 * Sentry with the card's kind, so the next one comes with its stack.
 */
import * as React from 'react'
import * as Sentry from '@sentry/nextjs'
import { Button } from '@/components/ui/button'

interface Props {
  /** The card's kind (`spreadsheets`, `record`, `list`, …): the Sentry tag. */
  kind: string
  children: React.ReactNode
}

interface State {
  error: Error | null
  /** Bumped by Try again: the body mounts afresh under a new key. */
  attempt: number
}

export class CardErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`[CardErrorBoundary] ${this.props.kind}`, error, info.componentStack)
    Sentry.captureException(error, {
      tags: { boundary: 'chat-card', card_kind: this.props.kind },
      contexts: { react: { componentStack: info.componentStack ?? '' } },
    })
  }

  private retry = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))

  render() {
    if (this.state.error) {
      return (
        <div role="alert" data-card-error={this.props.kind} className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">Couldn&apos;t open this.</p>
          <Button size="sm" variant="outline" onClick={this.retry}>
            Try again
          </Button>
        </div>
      )
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>
  }
}
