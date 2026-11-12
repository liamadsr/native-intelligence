'use client'

/** The Site audit page's load states: a centered spinner, and a centered line with Try again. */
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** A centered spinner while the first read is out. */
export function CenteredLoader() {
  return (
    <div data-seo-loading="" className="flex h-full min-h-40 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  )
}

/** A centered line and Try again when a read failed. */
export function CenteredError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div data-seo-error="" className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
