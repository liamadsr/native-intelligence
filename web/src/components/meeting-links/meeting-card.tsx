import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { cn } from '@/lib/utils'
import { LocalTime } from './local-time'

/**
 * A clear glass panel on the public sky (components/sky/public-sky.tsx, behind
 * every page under /m): the page's own surface colour, mostly see-through, so
 * the weather shows through it in both themes. No fill or glow of its own.
 */
export const MEETING_GLASS = 'border border-foreground/10 bg-background/55 text-foreground shadow-xl dark:bg-white/[0.07] shadow-black/5 backdrop-blur-2xl dark:shadow-none'

/**
 * The frame of every public meeting page (src/app/m/[token]): the sky behind
 * (nothing here paints a background), our name at the top, the page's content
 * in the middle of what is left, and one line at the foot saying what this is.
 * Someone invited to a meeting meets Native Intelligence here first.
 */
export function MeetingShell({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <main className="flex min-h-dvh flex-col text-foreground" {...rest}>
      <header className="flex h-16 shrink-0 items-center px-5 sm:px-8">
        <Logo className="h-6" />
      </header>
      <div className={cn('flex flex-1 items-center justify-center px-4 py-6 sm:px-8', className)}>{children}</div>
      <footer className="shrink-0 px-5 pb-6 pt-2 text-center text-xs text-foreground/60 sm:px-8">Meetings by Native Intelligence</footer>
    </main>
  )
}

/**
 * The public meeting page's plain card (src/app/m/[token]): a link that no
 * longer works, one that opens later, too many tries, a member's Join. No app
 * around it.
 */
export function MeetingCard({ title, description, opensAt, children }: { title: string; description: ReactNode; opensAt?: string; children?: ReactNode }) {
  return (
    <MeetingShell data-meeting-card="">
      <div className={cn('w-full max-w-md rounded-3xl p-6 sm:p-8', MEETING_GLASS)}>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {opensAt && (
          <p className="mt-5 rounded-2xl border border-foreground/10 bg-foreground/[0.04] px-4 py-3 text-sm">
            Opens at{' '}
            <strong className="font-semibold">
              <LocalTime iso={opensAt} />
            </strong>
          </p>
        )}
        {children}
      </div>
    </MeetingShell>
  )
}
