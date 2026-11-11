import type { ReactNode } from 'react'
import { Mark } from '@/components/logo'
import { LocalTime } from './local-time'

/**
 * The public meeting page's plain card (src/app/m/[token]): a link that no
 * longer works, one that opens later, too many tries. No app around it.
 */
export function MeetingCard({ title, description, opensAt, children }: { title: string; description: ReactNode; opensAt?: string; children?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground" data-meeting-card="">
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <Mark className="h-8 fill-foreground" />
        <h1 className="mt-5 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {opensAt && (
          <p className="mt-4 rounded-2xl bg-muted px-4 py-3 text-sm">
            Opens at{' '}
            <strong className="font-semibold">
              <LocalTime iso={opensAt} />
            </strong>
          </p>
        )}
        {children}
      </div>
    </main>
  )
}
