'use client'

import { useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { EmailRecipientInput } from './email-recipient-input'
import {
  MAX_DRAFT_BODY,
  MAX_DRAFT_RECIPIENTS,
  MAX_DRAFT_SUBJECT,
  isDraftAddress,
  parseDraftEdits,
  type DraftEdits,
} from '@/lib/email/draft-edits'

interface DraftEditorProps {
  /** The draft as it is now: where editing starts. */
  initial: DraftEdits
  sending: boolean
  onSend: (edits: DraftEdits) => void
  onCancel: () => void
}

/**
 * A draft, editable before it is sent: recipients, subject and the message as
 * plain text. Send sends what is here (the draft itself is updated as it goes
 * out); Cancel leaves the draft as it was. Cmd/Ctrl+Enter sends.
 */
export function DraftEditor({ initial, sending, onSend, onCancel }: DraftEditorProps) {
  const [to, setTo] = useState(initial.to)
  const [cc, setCc] = useState(initial.cc)
  const [showCc, setShowCc] = useState(initial.cc.length > 0)
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)

  // The route's own check, so what Send allows is what the server takes.
  const edits = { to, cc, subject, body }
  const problem = problemWith(edits)
  const canSend = !sending && parseDraftEdits(edits) !== 'invalid'
  const send = () => {
    if (canSend) onSend(edits)
  }
  // On the subject and the message only: in a recipient field, Enter first
  // adds the address being typed.
  const sendOnModEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1 text-sm">
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0 pt-1.5 text-xs text-muted-foreground">To</span>
          <EmailRecipientInput values={to} onChange={setTo} placeholder="Add recipients" />
          {!showCc && (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Cc
            </button>
          )}
        </div>
        {showCc && (
          <div className="flex items-start gap-2">
            <span className="w-14 shrink-0 pt-1.5 text-xs text-muted-foreground">Cc</span>
            <EmailRecipientInput values={cc} onChange={setCc} placeholder="Add recipients" />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-xs text-muted-foreground">Subject</span>
          <input
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={sendOnModEnter}
            className="h-7 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        {problem && <p className="text-xs text-destructive">{problem}</p>}
      </div>

      <Textarea
        aria-label="Message"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={sendOnModEnter}
        className="min-h-[220px] resize-y text-sm leading-relaxed"
        autoFocus
      />

      <div className="flex items-center gap-2 border-t border-border/40 pt-3">
        <Button size="sm" className="gap-1.5" onClick={send} disabled={!canSend}>
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {sending ? 'Sending…' : 'Send'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Why Send is off, when the reason isn't plain to see (an empty To is). */
function problemWith({ to, cc, subject, body }: DraftEdits): string | null {
  const bad = [...to, ...cc].filter((a) => !isDraftAddress(a.trim()))
  if (bad.length > 0) return `Check ${bad.length === 1 ? 'this address' : 'these addresses'}: ${bad.join(', ')}`
  if (to.length + cc.length > MAX_DRAFT_RECIPIENTS) return `Send to ${MAX_DRAFT_RECIPIENTS} people at most`
  if (subject.length > MAX_DRAFT_SUBJECT) return 'The subject is too long'
  if (body.length > MAX_DRAFT_BODY) return 'The message is too long'
  return null
}

const SKIPPED = new Set(['HEAD', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE'])
const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TR', 'UL',
])
/** What a plain-text edit loses from a draft's HTML. */
const FORMATTING = new Set([
  'A', 'B', 'BLOCKQUOTE', 'CODE', 'DEL', 'EM', 'FONT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR',
  'I', 'IMG', 'OL', 'PRE', 'S', 'STRIKE', 'STRONG', 'TABLE', 'U', 'UL',
])

/**
 * A message's text to start editing from: its plain-text part, else its HTML
 * read the way it shows (Outlook's drafts come as HTML only): a line per
 * block and per <br>, source whitespace collapsed, a list item marked, a
 * link's address after its text. Parsed, never rendered.
 */
export function draftTextOf(bodyText: string | null, bodyHtml: string | null): string {
  if (bodyText) return bodyText
  if (!bodyHtml) return ''
  const lines: string[] = []
  let line = ''
  const endLine = () => {
    lines.push(line.replace(/\u00a0/g, ' ').trimEnd())
    line = ''
  }
  // A block starts and ends a line; an empty one (<div></div>) makes none.
  const endBlock = () => {
    if (line) endLine()
  }
  let pre = 0
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? ''
      if (pre > 0) {
        // Preformatted: its spaces and line breaks are the text.
        raw.split(/\r?\n/).forEach((part, i) => {
          if (i > 0) endLine()
          line += part
        })
        return
      }
      // Collapsible whitespace only: a non-breaking space is text.
      const text = raw.replace(/[ \t\n\r\f]+/g, ' ')
      line += !line || line.endsWith(' ') ? text.replace(/^ /, '') : text
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (SKIPPED.has(el.tagName)) return
    if (el.tagName === 'BR') return endLine()
    const block = BLOCKS.has(el.tagName)
    if (block) endBlock()
    if (el.tagName === 'LI') {
      const list = el.parentElement
      line += list?.tagName === 'OL' ? `${[...list.children].indexOf(el) + 1}. ` : '- '
    }
    if (el.tagName === 'PRE') pre++
    el.childNodes.forEach(walk)
    if (el.tagName === 'PRE') pre--
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? ''
      const label = el.textContent?.trim()
      if (label && /^https?:\/\//i.test(href) && label !== href) line = `${line.trimEnd()} (${href})`
    }
    if ((el.tagName === 'TD' || el.tagName === 'TH') && line && !line.endsWith(' ')) line += ' '
    if (block) endBlock()
  }
  walk(new DOMParser().parseFromString(bodyHtml, 'text/html').body)
  endBlock()
  // Blank lines at either end are layout, not text.
  return lines.join('\n').replace(/^\n+|\n+$/g, '')
}

/** Whether a draft's HTML has formatting (links, emphasis, lists, images, tables, quotes) its edited text would lose. */
export function draftFormattingLost(bodyHtml: string | null): boolean {
  if (!bodyHtml) return false
  const body = new DOMParser().parseFromString(bodyHtml, 'text/html').body
  return [...body.querySelectorAll('*')].some((el) => FORMATTING.has(el.tagName))
}
