'use client'

/**
 * The row under a thread's subject: what the app worked out about it, the
 * tags the person gave it, and who is on it.
 *
 *  - Automatic labels, marked as such (a sparkle, "Added automatically"): "To
 *    respond" when triage says the thread wants a reply, and the category it
 *    filed the thread under (email_thread_index.auto_classified). They are read
 *    only here: triage owns them.
 *  - The person's own tags (the workspace's labels, as before), each removable,
 *    and "+ Add tags", which opens the same label picker the header's tag
 *    button does.
 *  - The people on the thread as chips: "Me" for the person's own addresses,
 *    the first few shown and the rest behind "+N more".
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Plus, Sparkles, Tag, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface ThreadTagLabel {
  id: string
  name: string
  color: string
}

export interface ThreadPerson {
  name: string | null
  email: string
}

/** People shown before "+N more". */
export const PEOPLE_SHOWN = 5

const CATEGORY: Record<string, { label: string; tone: string }> = {
  important: { label: 'Important', tone: 'text-amber-600 bg-amber-500/10 dark:text-amber-400' },
  personal: { label: 'Personal', tone: 'text-emerald-600 bg-emerald-500/10 dark:text-emerald-400' },
  newsletter: { label: 'Newsletter', tone: 'text-violet-600 bg-violet-500/10 dark:text-violet-400' },
  notification: { label: 'Notification', tone: 'text-sky-600 bg-sky-500/10 dark:text-sky-400' },
  transactional: { label: 'Receipt', tone: 'text-slate-600 bg-slate-500/10 dark:text-slate-300' },
}

export interface AutomaticLabel {
  key: string
  label: string
  tone: string
}

/** The labels triage gave the thread, most pressing first. An unknown category is shown under its own name. Pure. */
export function automaticLabels(metadata: { needs_reply?: boolean | null; auto_classified?: string | null }): AutomaticLabel[] {
  const out: AutomaticLabel[] = []
  if (metadata.needs_reply) out.push({ key: 'needs_reply', label: 'To respond', tone: 'text-blue-500 bg-blue-500/10' })
  const category = metadata.auto_classified?.trim().toLowerCase()
  if (category) {
    const known = CATEGORY[category]
    out.push({
      key: `category:${category}`,
      label: known?.label ?? category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' '),
      tone: known?.tone ?? 'text-muted-foreground bg-muted',
    })
  }
  return out
}

/**
 * Everyone on the thread, once each, in the order they first appear (senders
 * before the people they wrote to), the person's own addresses as "Me". Pure.
 */
export function threadPeople(
  messages: ReadonlyArray<{ from: ThreadPerson; to: readonly ThreadPerson[]; cc: readonly ThreadPerson[] }>,
  own: ReadonlySet<string>,
): Array<ThreadPerson & { me: boolean; label: string }> {
  const seen = new Map<string, ThreadPerson & { me: boolean; label: string }>()
  const add = (person: ThreadPerson | null | undefined) => {
    const email = person?.email?.trim().toLowerCase()
    if (!email) return
    const existing = seen.get(email)
    const name = person?.name?.trim() || null
    if (existing) {
      // A later message may carry the name an earlier one lacked.
      if (!existing.name && name && !existing.me) {
        existing.name = name
        existing.label = name.split(/\s+/)[0]
      }
      return
    }
    const me = own.has(email)
    seen.set(email, { email, name, me, label: me ? 'Me' : name ? name.split(/\s+/)[0] : email.split('@')[0] })
  }
  for (const m of messages) add(m.from)
  for (const m of messages) {
    for (const p of m.to) add(p)
    for (const p of m.cc) add(p)
  }
  return [...seen.values()]
}

function initial(person: { label: string }): string {
  return person.label.charAt(0).toUpperCase()
}

export function EmailThreadTags({
  metadata,
  labels,
  onRemoveLabel,
  picker,
  messages,
  ownAddresses,
  children,
}: {
  metadata: { needs_reply?: boolean | null; auto_classified?: string | null }
  labels: readonly ThreadTagLabel[]
  onRemoveLabel: (labelId: string) => void
  /** The label picker, drawn inside "+ Add tags". */
  picker: ReactNode
  messages: ReadonlyArray<{ from: ThreadPerson; to: readonly ThreadPerson[]; cc: readonly ThreadPerson[] }>
  ownAddresses: ReadonlySet<string>
  /** More chips for the row (the linked contact, the shares). */
  children?: ReactNode
}) {
  const [allPeople, setAllPeople] = useState(false)
  const auto = automaticLabels(metadata)
  const people = useMemo(() => threadPeople(messages, ownAddresses), [messages, ownAddresses])
  const shownPeople = allPeople ? people : people.slice(0, PEOPLE_SHOWN)

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-email-thread-tags="">
      {auto.map((label) => (
        <span
          key={label.key}
          data-auto-label={label.key}
          title="Added automatically"
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', label.tone)}
        >
          <Sparkles className="h-3 w-3" aria-hidden />
          {label.label}
        </span>
      ))}

      {labels.map((label) => (
        <span
          key={label.id}
          data-thread-label={label.id}
          className="inline-flex max-w-[30ch] items-center gap-1 rounded-full border border-border/70 py-0.5 pl-2 pr-0.5 text-xs"
        >
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
          <span className="truncate">{label.name}</span>
          <button
            type="button"
            onClick={() => onRemoveLabel(label.id)}
            aria-label={`Remove ${label.name}`}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-add-tags=""
            aria-label="Add tags"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-solid hover:bg-muted hover:text-foreground"
          >
            {labels.length === 0 ? (
              <>
                <Tag className="h-3 w-3" />
                Add tags
              </>
            ) : (
              <Plus className="h-3 w-3" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          {picker}
        </PopoverContent>
      </Popover>

      {children}

      {people.length > 0 && <span className="mx-0.5 h-3.5 w-px bg-border" aria-hidden />}
      {shownPeople.map((person) => (
        <span
          key={person.email}
          data-thread-person={person.email}
          title={person.name ? `${person.name} <${person.email}>` : person.email}
          className="inline-flex items-center gap-1 rounded-full border border-border/70 py-0.5 pl-0.5 pr-2 text-xs"
        >
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-medium">{initial(person)}</span>
          {person.label}
        </span>
      ))}
      {people.length > PEOPLE_SHOWN && (
        <button
          type="button"
          data-more-people=""
          onClick={() => setAllPeople((v) => !v)}
          className="rounded-full px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {allPeople ? 'Show fewer' : `+${people.length - PEOPLE_SHOWN} more`}
        </button>
      )}
    </div>
  )
}
