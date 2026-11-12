'use client'

/**
 * The Mail page's panel: its sub-nav (Liam, 11-11: "next for the mail page we
 * should build something like this where you can see and select all the
 * accounts you have selected all the inbox, faves, sent... and any tags that
 * are available for email"). PAGE_PANELS.mail (page-panel.tsx): it holds the
 * slot while Mail is the selected page.
 *
 *   What    Accounts: All accounts (with two or more), then each connected
 *           mailbox here (its initial on its colour, and its address), then
 *           Connect another account (the connectors settings, as the
 *           calendar's connect does). The folders, no heading: Inbox (its
 *           unread count), To review, Starred, Drafts (counts where the page
 *           shows one), Sent; then Archive, Spam, Trash
 *           (components/email/mail-folders.ts, the page's own list: our
 *           words, our icons). Tags: the workspace's labels for email
 *           (`/api/account/labels?scope=email_thread`, the labels a thread
 *           can wear), each its colour's dot and name, only when there are
 *           any. No "New": writing an email stays the page's own button and
 *           the composer.
 *   Look    My Actions' sub-nav's (tasks-panel.tsx): the same floating card
 *           (page-panel-frame.tsx), small muted headings, 32px rows, a plain
 *           muted glyph, no title row.
 *   A row   moves the Mail card in front, as its own controls do
 *           (components/chat-cards/mail-card-controls.ts): an account is the
 *           state its account dropdown sets (one mailbox, or all); a folder
 *           is its folder Select's move (a step in the card's history, so
 *           Back returns); a tag filters the list to the threads wearing it,
 *           in every folder but Spam and Trash (again, or a folder, clears
 *           it; this leaving the card's side clears it, nothing else on
 *           screen showing it). The full-screen card has no dropdown or
 *           Select of its own from `md` up (email-layout.tsx): this is its
 *           one control for each, so it shows while open, room or not
 *           (Liam, 11-11).
 *   Lit     from where the card is, never from a click (the rail's tint,
 *           `aria-current`): the mailboxes it lists, and its folder, or its
 *           tag while it has one. Back and the page's own controls keep it
 *           right.
 *   Kept    it wears KEEP_PLACE_ATTR (rail/selected-place.ts): what a press
 *           in it opens keeps the page selected.
 *
 *   At once its rows come with the page, before the card has loaded (Liam,
 *           11-11: "it goes away completely and reappears every time" … "only
 *           on first load"): the folders are a fixed list, the accounts and
 *           tags shared reads; the counts and the lit rows come when the card
 *           says where it is (until then the page's default: Inbox, every
 *           mailbox). A row pressed before then moves the card once it says
 *           (pending-move.ts).
 *
 * Flat cost: no timer. The folders' counts are the card's own read; the
 * accounts the dropdown's cached read (useConnectedAccounts: one request for
 * every reader); the labels one shared read (useScopedLabels), made only once
 * the panel first shows.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Mails, Plus, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectedAccounts, type ConnectedAccount } from '@/components/account-filter-dropdown'
import { useMailCard, type MailCardControls } from '@/components/chat-cards/mail-card-controls'
import type { FrontCard } from '@/components/chat-cards/front-card'
import { MAIL_FOLDER_ENTRIES, type FolderCounts, type MailFolderEntry } from '@/components/email/mail-folders'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import { KEEP_PLACE_ATTR } from '../rail/selected-place'
import { PagePanelFrame } from './page-panel-frame'
import { PAGE_PANEL_LABELS, type PagePanelProps } from './page-panel-types'
import { usePendingMove } from './pending-move'

/** The folders as the sub-nav groups them: the everyday ones, then (after a gap) where mail is put away. */
export const MAIL_PANEL_FOLDER_GROUPS: readonly (readonly string[])[] = [
  ['inbox', 'review', 'starred', 'drafts', 'sent'],
  ['archive', 'spam', 'trash'],
]

const folderEntry = (id: string): MailFolderEntry | undefined => MAIL_FOLDER_ENTRIES.find((f) => f.id === id)

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), as tasks-panel.tsx's ROW_LIT. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

/** Where the card is, as the rows light it: the card's own, or the page's default before it says. */
type MailPlace = Pick<MailCardControls, 'folder' | 'accounts' | 'labelId' | 'counts'>
const NO_COUNTS: FolderCounts = {}
const DEFAULT_PLACE: MailPlace = { folder: 'inbox', accounts: null, labelId: null, counts: NO_COUNTS }

export function MailPanel({ active, mode, front, onContent }: PagePanelProps) {
  const card = useMailCard(front?.id ?? null)
  // Its folders are always there: something to show from its first commit, card or not.
  useLayoutEffect(() => {
    onContent('mail', true)
  }, [onContent])

  // A tag is this sub-nav's filter alone: leaving the card's side (closed,
  // another page selected, gone), it clears it on that card, as nothing
  // else on screen would show it.
  const shown = active && mode !== 'off' && !!card
  const cardId = card?.cardId ?? null
  const cardRef = useRef(card)
  cardRef.current = card
  useEffect(() => {
    if (!shown || !cardId) return
    return () => {
      const was = cardRef.current
      if (was?.cardId === cardId && was.labelId) was.setLabel(null)
    }
  }, [shown, cardId])

  const run = usePendingMove<MailCardControls>(card, active)
  return (
    <PagePanelFrame mode={mode} active={active} label={PAGE_PANEL_LABELS.mail} page="mail">
      {/* Mounted with the frame, on its first showing: the labels are read then, not before. */}
      <MailPanelRows place={card ?? DEFAULT_PLACE} run={run} front={front} />
    </PagePanelFrame>
  )
}

function MailPanelRows({
  place: card,
  run,
  front,
}: {
  place: MailPlace
  /** A move on the card: now, or once it says where it is (pending-move.ts). */
  run: (move: (card: MailCardControls) => void) => void
  front: FrontCard | null
}) {
  const accounts = useConnectedAccounts('email')
  const { labels } = useScopedLabels('email_thread')
  const settings = useOptionalSettingsOverlay()
  const router = useRouter()

  // A record opened over the page as its own card is in front: the page's card comes back first.
  const frontRef = useRef(front)
  frontRef.current = front
  const inFront = (c: MailCardControls) => c.cardId === frontRef.current?.id
  const bringBack = (c: MailCardControls) => {
    if (!inFront(c)) c.show()
  }

  const single = accounts.length === 1
  const allLit = card.accounts === null
  const accountLit = (id: string) => (card.accounts ? card.accounts.includes(id) : single)
  const pickAccount = (id: string | null) =>
    run((c) => {
      bringBack(c)
      const next = id ? [id] : null
      if (JSON.stringify(next) !== JSON.stringify(c.accounts)) c.setAccounts(next)
    })
  // The connect flow the page's own "Connect email" opens: the connectors settings, in the overlay where it is.
  const connect = () => {
    if (settings) settings.openSettings('connectors')
    else router.push('/account/settings/connectors')
  }

  const folderLit = (id: string) => !card.labelId && card.folder === id
  const pickFolder = (id: string) =>
    run((c) => {
      if (!c.labelId && c.folder === id && inFront(c)) return
      bringBack(c)
      c.setFolder(id)
    })

  const pickLabel = (id: string) =>
    run((c) => {
      bringBack(c)
      c.setLabel(c.labelId === id ? null : id)
    })

  return (
    <nav
      aria-label={PAGE_PANEL_LABELS.mail}
      data-mail-panel=""
      {...{ [KEEP_PLACE_ATTR]: '' }}
      className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep"
    >
      {/* Sections as blocks, as the Tasks sub-nav's: 12px between one's last row and the next heading. */}
      <div className="ph-no-capture flex flex-col gap-3">
        <section data-mail-section="accounts" aria-labelledby="mail-accounts">
          <Heading id="mail-accounts">Accounts</Heading>
          <ul className="flex flex-col">
            {accounts.length > 1 && (
              <li>
                <Row rowKey="account:all" lit={allLit} onPress={() => pickAccount(null)} label="All accounts" glyph={<Glyph icon={Mails} />} />
              </li>
            )}
            {accounts.map((account) => (
              <li key={account.id}>
                <Row
                  rowKey={`account:${account.id}`}
                  lit={accountLit(account.id)}
                  onPress={() => pickAccount(single ? null : account.id)}
                  label={account.account_email}
                  glyph={<AccountInitial account={account} />}
                />
              </li>
            ))}
            <li>
              <Row rowKey="connect" lit={false} onPress={connect} label={accounts.length > 0 ? 'Connect another account' : 'Connect an account'} glyph={<Glyph icon={Plus} />} muted />
            </li>
          </ul>
        </section>

        {MAIL_PANEL_FOLDER_GROUPS.map((ids, i) => (
          <section key={i} data-mail-section={i === 0 ? 'folders' : 'library'} aria-label={i === 0 ? 'Folders' : 'More folders'}>
            <ul className="flex flex-col">
              {ids.map((id) => {
                const folder = folderEntry(id)
                if (!folder) return null
                const count = folder.countKey ? card.counts[folder.countKey] : undefined
                return (
                  <li key={id}>
                    <Row
                      rowKey={`folder:${id}`}
                      lit={folderLit(id)}
                      onPress={() => pickFolder(id)}
                      label={folder.label}
                      glyph={<Glyph icon={folder.icon} />}
                      count={count ? `${count}` : undefined}
                      countLabel={count ? `${count}${folder.countUnit ? ` ${folder.countUnit}` : ''}` : undefined}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

        {labels.length > 0 && (
          <section data-mail-section="tags" aria-labelledby="mail-tags">
            <Heading id="mail-tags">Tags</Heading>
            <ul className="flex flex-col">
              {labels.map((label) => (
                <li key={label.id}>
                  <Row
                    rowKey={`label:${label.id}`}
                    lit={card.labelId === label.id}
                    onPress={() => pickLabel(label.id)}
                    label={label.name}
                    glyph={<span data-mail-tag-dot="" className="size-2 rounded-full" style={{ backgroundColor: label.color }} />}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </nav>
  )
}

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
      {children}
    </h3>
  )
}

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4" strokeWidth={1.75} />
}

/** A mailbox's initial on its own colour (accounts carry a colour, no picture). */
function AccountInitial({ account }: { account: ConnectedAccount }) {
  const initial = (account.display_name || account.account_email).trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      data-mail-account-initial=""
      className="flex size-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white"
      style={{ backgroundColor: account.color || '#6b7280' }}
    >
      {initial}
    </span>
  )
}

function Row({
  rowKey,
  lit,
  onPress,
  label,
  glyph,
  count,
  countLabel,
  muted,
}: {
  rowKey: string
  lit: boolean
  onPress: () => void
  label: string
  glyph: ReactNode
  count?: string
  countLabel?: string
  muted?: boolean
}) {
  return (
    <button
      type="button"
      data-mail-row={rowKey}
      aria-current={lit ? 'true' : undefined}
      onClick={onPress}
      title={label}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
        lit ? ROW_LIT : 'hover:bg-muted/60',
      )}
    >
      <span aria-hidden data-mail-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {glyph}
      </span>
      <span data-mail-label="" className={cn('min-w-0 flex-1 truncate text-[13px]', muted ? 'text-muted-foreground' : 'text-foreground')}>
        {label}
      </span>
      {count && (
        <span data-mail-count="" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          <span aria-hidden>{count}</span>
          <span className="sr-only">, {countLabel}</span>
        </span>
      )}
    </button>
  )
}
