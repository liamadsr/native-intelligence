'use client'

/**
 * The thread pane on a made-up thread (see page.tsx). Every request under
 * /api/account/ is answered here: the thread, its labels, its shares, the
 * scheduled list, and Send (which only waits a moment and says it sent).
 * Made-up people and addresses only (`.example`).
 */
import { useEffect, useRef, useState } from 'react'
import { Toaster } from 'sonner'
import { EmailThreadDetail, type ThreadKeyActions } from '@/components/email/email-thread-detail'
import { MarketingSky } from '@/components/sky/marketing-sky'

const ME = 'jordan@northwind.example'

const THREAD = {
  threadId: 'preview-thread',
  accountId: 'preview-account',
  mailboxEmail: ME,
  indexId: null,
  subject: 'Pilot scope for the Harborline rollout',
  contact: null,
  drafts: [],
  metadata: { needs_reply: true, auto_classified: 'important', linked_capture_id: null },
  messages: [
    {
      id: 'm1',
      threadId: 'preview-thread',
      from: { name: 'Sam Rivera', email: 'sam@harborline.example' },
      to: [{ name: 'Jordan Vale', email: ME }],
      cc: [{ name: 'Priya Natarajan', email: 'priya@harborline.example' }],
      subject: 'Pilot scope for the Harborline rollout',
      date: '2026-09-08T16:12:00Z',
      bodyHtml: null,
      bodyText: 'Hi Jordan, sharing the first cut of the pilot scope. Three sites, six weeks, and a weekly check-in with our ops lead.',
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      attachments: [],
    },
    {
      id: 'm2',
      threadId: 'preview-thread',
      from: { name: 'Jordan Vale', email: ME },
      to: [{ name: 'Sam Rivera', email: 'sam@harborline.example' }],
      cc: [{ name: 'Priya Natarajan', email: 'priya@harborline.example' }],
      subject: 'Re: Pilot scope for the Harborline rollout',
      date: '2026-09-08T18:40:00Z',
      bodyHtml: null,
      bodyText: 'Thanks Sam. Six weeks works. Could we start with the Portside site?',
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      attachments: [],
    },
    {
      id: 'm3',
      threadId: 'preview-thread',
      from: { name: 'Sam Rivera', email: 'sam@harborline.example' },
      to: [{ name: 'Jordan Vale', email: ME }],
      cc: [{ name: 'Priya Natarajan', email: 'priya@harborline.example' }],
      subject: 'Re: Pilot scope for the Harborline rollout',
      date: '2026-09-09T09:05:00Z',
      bodyHtml:
        '<div><p>Hi Jordan,</p><p>Portside first makes sense. I’ve attached the revised plan with the site order and the check-in calendar. Two open questions on our side:</p><ul><li>Do you want the ops dashboard live in week one, or after the first check-in?</li><li>Who on your team should get the weekly summary?</li></ul><p>If it helps, Priya can walk your team through the plan on Thursday.</p><p>Best,<br>Sam</p></div><div class="gmail_quote"><p>On Mon, Sep 8, Jordan Vale wrote:</p><blockquote>Thanks Sam. Six weeks works. Could we start with the Portside site?</blockquote></div>',
      bodyText: null,
      isUnread: false,
      isStarred: false,
      hasAttachments: true,
      attachments: [
        { name: 'Harborline pilot plan v2.pdf', size: 482_133, mimeType: 'application/pdf' },
        { name: 'Check-in calendar.xlsx', size: 38_420, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      ],
    },
  ],
}

const LIST = [
  { id: 'preview-thread', from: 'Sam Rivera', subject: 'Pilot scope for the Harborline rollout', snippet: 'Portside first makes sense. I’ve attached…', when: 'Sep 9', unread: false, selected: true },
  { id: 't2', from: 'Lee Park', subject: 'Invoice 2041', snippet: 'Attached is the invoice for September…', when: 'Sep 8', unread: true },
  { id: 't3', from: 'Maya Chen', subject: 'Coffee next week?', snippet: 'I’m around Tuesday or Wednesday…', when: 'Sep 7', unread: false },
  { id: 't4', from: 'Ops Weekly', subject: 'Your weekly summary', snippet: 'Three sites on track, one waiting…', when: 'Sep 6', unread: false },
]

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function useFixtureRoutes() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      const path = new URL(url, window.location.origin).pathname
      if (!path.startsWith('/api/')) return real(input, init)
      if (path === '/api/account/email/send') {
        await new Promise((r) => setTimeout(r, 500))
        return json({ message_id: 'preview-sent', thread_id: 'preview-thread', rfc_message_id: null })
      }
      if (path === '/api/account/email/save-draft') return json({ draft_id: 'preview-draft', thread_id: 'preview-thread' })
      if (path.startsWith('/api/account/email/scheduled')) return json({ scheduled: [] })
      if (path.endsWith('/labels')) return json({ labels: [] })
      if (path === '/api/account/email/threads/preview-thread') return json(THREAD)
      if (path.startsWith('/api/account/email/shares')) return json({ shares: [], links: [] })
      // Anything else under /api answers empty: this page talks to no server.
      return json({})
    }
    setReady(true)
    return () => {
      window.fetch = real
    }
  }, [])
  return ready
}

export default function MailThreadPreview() {
  const ready = useFixtureRoutes()
  const keys = useRef<ThreadKeyActions | null>(null)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
    if (params.get('theme') === 'light') document.documentElement.classList.remove('dark')
  }, [])
  useEffect(() => {
    if (!ready) return
    const mode = new URLSearchParams(window.location.search).get('compose')
    if (!mode) return
    const t = setTimeout(() => {
      if (mode === 'replyAll') keys.current?.replyAll()
      else if (mode === 'forward') keys.current?.forward()
      else keys.current?.reply()
    }, 800)
    return () => clearTimeout(t)
  }, [ready])
  if (!ready) return null
  return (
    <>
      <MarketingSky />
      <Toaster position="bottom-center" />
      <main className="relative flex h-dvh gap-3 p-4">
        <section className="hidden w-[340px] shrink-0 flex-col overflow-hidden rounded-3xl bg-background/80 shadow-sm backdrop-blur-xl md:flex">
          <div className="px-4 pb-2 pt-4 text-sm font-semibold">Inbox</div>
          {LIST.map((t) => (
            <div key={t.id} className={`mx-2 rounded-2xl px-3 py-2.5 ${t.selected ? 'bg-foreground/[0.06]' : ''}`}>
              <div className="flex items-baseline gap-2">
                <span className={`truncate text-sm ${t.unread ? 'font-semibold' : 'font-medium'}`}>{t.from}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t.when}</span>
              </div>
              <div className="truncate text-sm">{t.subject}</div>
              <div className="truncate text-xs text-muted-foreground">{t.snippet}</div>
            </div>
          ))}
        </section>
        <section className="min-w-0 flex-1 overflow-hidden rounded-3xl bg-background/80 shadow-sm backdrop-blur-xl">
          <EmailThreadDetail threadId="preview-thread" ownAddresses={[ME]} keyActionsRef={keys} onPrev={() => {}} onNext={() => {}} />
        </section>
      </main>
    </>
  )
}
