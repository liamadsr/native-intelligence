'use client'

/**
 * Managing a conversation (migration 714, docs/plans/team-chat-manage.md;
 * the owner, 11-23: "there's no way to edit a channel in team-chat or rename
 * a group chat or completely delete a meeting channel"; and channels too:
 * "they let you delete it, we should too").
 *
 *   TeamChatManageMenu       the conversation header's menu, beside its
 *                            notifications: Edit and Delete channel (a
 *                            channel), Rename and Delete meeting chat (a
 *                            meeting chat), Delete last, in red, after a
 *                            divider. Shown
 *                            only to someone who may (TeamChatChannel's
 *                            can_manage); the database decides again.
 *   EditConversationDialog   a channel's name and topic, or a meeting chat's
 *                            name. A name another channel has comes back as
 *                            words under the field, the dialog still open.
 *   DeleteConversationDialog the confirmation: it names the channel or
 *                            meeting chat and counts what goes (messages,
 *                            files, polls, calls, a meeting's link) and what
 *                            stays (the call notes, as their owner's own). Delete stays off until the
 *                            counts are in, and while a call is live.
 *
 * The page's own dialogs (ui/dialog, ui/alert-dialog), as New message and
 * New meeting link are.
 */
import { Fragment, useEffect, useState } from 'react'
import { Pencil, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { TEAM_CHAT_NAME_MAX, TEAM_CHAT_TOPIC_MAX, type TeamChatChannel } from '@/lib/team-chat/types'
import type { ConversationContents, TeamChatEditedChannel } from '@/lib/team-chat/manage'

export type TeamChatManageWhat = 'edit' | 'delete'

/** Of a conversation, what its manager is offered: Edit and Delete for a channel; Rename and Delete for a meeting chat; nothing for a DM. Delete is last. */
export function manageChoices(channel: Pick<TeamChatChannel, 'kind' | 'can_manage'>): Array<{ what: TeamChatManageWhat; label: string }> {
  // Never a DM, never a support conversation (715: its customer deletes it their own way, support_chat_remove).
  if (!channel.can_manage || channel.kind === 'dm' || channel.kind === 'support') return []
  if (channel.kind === 'channel')
    return [
      { what: 'edit', label: 'Edit channel…' },
      { what: 'delete', label: 'Delete channel…' },
    ]
  return [
    { what: 'edit', label: 'Rename meeting chat…' },
    { what: 'delete', label: 'Delete meeting chat…' },
  ]
}

export function TeamChatManageMenu({
  channel,
  onManage,
  inHeader = false,
  headerButtonClass,
}: {
  channel: Pick<TeamChatChannel, 'kind' | 'can_manage'>
  onManage: (what: TeamChatManageWhat) => void
  inHeader?: boolean
  headerButtonClass?: string
}) {
  const choices = manageChoices(channel)
  if (choices.length === 0) return null
  const what = channel.kind === 'channel' ? 'Channel settings' : 'Meeting chat settings'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-team-chat-manage=""
          aria-label={what}
          title={what}
          className={
            inHeader
              ? cn('grid size-6 shrink-0 place-items-center data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground', headerButtonClass)
              : 'shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent'
          }
        >
          <Settings2 className={inHeader ? 'size-3.5' : 'h-4 w-4'} strokeWidth={inHeader ? 1.75 : undefined} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {choices.map((c) =>
          c.what === 'delete' ? (
            <Fragment key={c.what}>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-team-chat-manage-item="delete" onSelect={() => onManage('delete')} className="text-destructive focus:text-destructive">
                <Trash2 className="h-4 w-4" />
                {c.label}
              </DropdownMenuItem>
            </Fragment>
          ) : (
            <DropdownMenuItem key={c.what} data-team-chat-manage-item="edit" onSelect={() => onManage('edit')}>
              <Pencil className="h-4 w-4" />
              {c.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The words of a failed answer: the server's own `error`, else a plain line. */
async function answerLine(res: Response, fallback: string): Promise<string> {
  try {
    const json = (await res.json()) as { error?: unknown }
    if (typeof json.error === 'string' && json.error.trim()) return json.error
  } catch {
    // No body: the fallback.
  }
  return fallback
}

export function EditConversationDialog({
  channel,
  open,
  onOpenChange,
  onSaved,
}: {
  channel: Pick<TeamChatChannel, 'id' | 'kind' | 'name' | 'topic'> | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (row: TeamChatEditedChannel) => void
}) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isChannel = channel?.kind === 'channel'

  useEffect(() => {
    if (!open || !channel) return
    setName(channel.name ?? '')
    setTopic(channel.topic ?? '')
    setError(null)
    setSaving(false)
  }, [open, channel])

  const tidyName = name.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim()
  const unchanged = !!channel && tidyName === (channel.name ?? '') && (!isChannel || topic.trim() === (channel.topic ?? ''))

  const save = async () => {
    if (!channel || saving) return
    if (!tidyName) return setError('Give it a name.')
    if (unchanged) return onOpenChange(false)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/team-chat/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isChannel ? { name: tidyName, topic: topic.trim() } : { name: tidyName }),
      })
      if (!res.ok) {
        setError(await answerLine(res, 'Couldn’t save that. Try again.'))
        return
      }
      const json = (await res.json()) as { channel: TeamChatEditedChannel }
      onSaved(json.channel)
      onOpenChange(false)
    } catch {
      setError('Couldn’t save that. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md [&>*]:min-w-0" data-team-chat-edit-dialog={channel?.kind ?? ''}>
        <DialogHeader>
          <DialogTitle>{isChannel ? 'Edit channel' : 'Rename meeting chat'}</DialogTitle>
          <DialogDescription>
            {isChannel
              ? 'Everyone who can see the channel sees the new name and topic, wherever it shows.'
              : 'The meeting takes the new name too: in Meetings, on its link’s page and for everyone in the chat.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <span className="relative block">
              {isChannel && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground" aria-hidden>#</span>}
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (error) setError(null)
                }}
                maxLength={TEAM_CHAT_NAME_MAX + 2}
                autoFocus
                aria-invalid={!!error}
                className={cn(isChannel && 'pl-6')}
                data-team-chat-edit-name=""
              />
            </span>
          </label>
          {isChannel && (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Topic</span>
              <Textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={TEAM_CHAT_TOPIC_MAX}
                rows={2}
                placeholder="What it’s for (optional)"
                className="min-h-0 resize-none"
                data-team-chat-edit-topic=""
              />
            </label>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert" data-team-chat-edit-error="">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!tidyName || saving} data-team-chat-edit-save="">
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** "3 messages", "1 file", … (nothing for a zero). */
function count(n: number, one: string, many: string): string | null {
  return n > 0 ? `${n} ${n === 1 ? one : many}` : null
}

/** What goes, in words, from the counts. */
export function conversationGoes(c: ConversationContents): string[] {
  const things = [
    count(c.messages, 'message', 'messages') ?? 'Its messages (there are none yet)',
    count(c.files, 'file', 'files'),
    count(c.polls, 'poll', 'polls'),
    count(c.calls, 'call and its recording', 'calls and their recordings'),
  ].filter((x): x is string => !!x)
  if (c.messages > 0) things[0] = `${things[0]}, with their threads and reactions`
  if (c.linkCurrent) things.push(c.booked ? 'The meeting link: it stops working, the booked guest’s too' : 'The meeting link: it stops working')
  things.push('Its notifications, and the conversation in everyone’s list')
  return things
}

export function DeleteConversationDialog({
  channel,
  title,
  open,
  onOpenChange,
  onDeleted,
}: {
  channel: Pick<TeamChatChannel, 'id' | 'kind'> | null
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (id: string) => void
}) {
  const [contents, setContents] = useState<ConversationContents | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const id = channel?.id ?? null
  const isChannel = channel?.kind === 'channel'
  const noun = isChannel ? 'channel' : 'meeting chat'

  useEffect(() => {
    if (!open || !id) return
    let gone = false
    setContents(null)
    setError(null)
    setDeleting(false)
    void (async () => {
      try {
        const res = await fetch(`/api/account/team-chat/channels/${id}/contents`)
        if (!res.ok) {
          const line = await answerLine(res, 'Couldn’t read what’s in it. Try again.')
          if (!gone) setError(line)
          return
        }
        const json = (await res.json()) as { contents: ConversationContents }
        if (!gone) setContents(json.contents)
      } catch {
        if (!gone) setError('Couldn’t read what’s in it. Check your connection and try again.')
      }
    })()
    return () => {
      gone = true
    }
  }, [open, id])

  const remove = async () => {
    if (!id || deleting) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/team-chat/channels/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        setError(await answerLine(res, 'Couldn’t delete it. Try again.'))
        return
      }
      onDeleted(id)
      onOpenChange(false)
    } catch {
      setError('Couldn’t delete it. Check your connection and try again.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && onOpenChange(next)}>
      <AlertDialogContent data-team-chat-delete-dialog="">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {isChannel ? `#${title}` : `“${title}”`} for everyone?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the {noun} completely, for everyone in it. It can’t be undone.{isChannel ? ' Its name is free to use again.' : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 text-sm" data-team-chat-delete-contents={contents ? 'ready' : 'loading'}>
          {contents ? (
            <>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Goes</p>
                <ul className="list-disc space-y-0.5 pl-5 text-foreground">
                  {conversationGoes(contents).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Stays</p>
                <ul className="list-disc space-y-0.5 pl-5 text-foreground">
                  {contents.notesKept > 0 && (
                    <li>
                      {contents.notesKept === 1 ? 'The call’s notes' : `The ${contents.notesKept} calls’ notes`}, as a private capture of whoever owns them (no one else sees them through the {noun} any more)
                    </li>
                  )}
                  <li>Anything made from it: tasks, documents and records</li>
                </ul>
              </div>
              {contents.liveCall && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" data-team-chat-delete-live="">
                  A call is on here now. End it before deleting the {noun}.
                </p>
              )}
            </>
          ) : error ? null : (
            <p className="text-muted-foreground">Counting what’s in it…</p>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert" data-team-chat-delete-error="">
              {error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <Button
            onClick={() => void remove()}
            disabled={!contents || contents.liveCall || deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-team-chat-delete-confirm=""
          >
            {deleting ? 'Deleting…' : `Delete ${noun}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
