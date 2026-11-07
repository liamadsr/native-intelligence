'use client'

/**
 * WHAT THE SAVE ACTUALLY DID, said once and left on screen (C5).
 *
 * Before this, the only report a save produced was `toast.success(
 * summarizeSaveResult(result))` — and a toast is the one surface a user can
 * miss entirely. That was tolerable when Save was a single button on a page the
 * user was staring at. It stopped being tolerable the moment Scout could save
 * fourteen rows and enroll them in a sequence from the chat strip beside the
 * list: the page's own numbers moved, the user never pressed anything, and a
 * four-second toast is not where "fourteen people are now in Q4 Outbound"
 * belongs.
 *
 * So the outcome became a BANNER, in the same slot RunOutcome uses, saying the
 * same kind of sentence RunOutcome says — clauses joined by " · ", zero clauses
 * dropped, each one a doorway to the rows it names:
 *
 *   > 6 companies and 8 people added to your CRM · 8 enrolled in Q4 Outbound ·
 *   > 2 need review · 1 skipped                                            [×]
 *
 * WHY THE CLAUSES ARE BUTTONS. A count with no way to reach what it counts is a
 * receipt, not a result. "2 need review" is the clause that matters most: those
 * are people the save route REFUSED because their employer could not be
 * verified, and the only way to act on them is to look at them. The chip filter
 * this opens is the one place they are gathered.
 *
 * WHY `source` EXISTS on the story but does not render. The page tells the same
 * sentence for its own save and for Scout's, deliberately — the user should not
 * have to learn two vocabularies for one outcome. It is carried so the page can
 * decide REPLACEMENT policy (a newer save of either origin replaces an older
 * story) and so a test can assert which path produced the banner on screen.
 *
 * THE ENROLL CLAUSE IS MERGED, NOT A SECOND BANNER. Add-to-sequence is
 * save-then-enroll: one user gesture, two writes. Two stacked banners would
 * report one action twice and make the user dismiss it twice.
 */

import { X } from 'lucide-react'

/** One save or publish (and possibly the enrollment that followed it), as the
 *  page and Scout both tell it. */
export interface SaveStory {
  /**
   * `saved` — the rows were kept ON THE LIST (curation, no CRM write);
   * `published` — they went into the CRM as the list's group (migration 259,
   * Liam 2026-09-06). The head clause says which; the doorways are the same.
   */
  kind: 'saved' | 'published'
  /** The list's name, when a list-level publish carried it — the head clause
   *  names the group the rows joined. */
  listName?: string | null
  /** Company entries saved to the list, or promoted to `company` rows. */
  companies: number
  /** Person entries saved to the list, or promoted to `contact` rows. */
  people: number
  /**
   * People the save route REFUSED because their employer is unverified —
   * `SkippedEntry.reason === 'needs_review'`. Counted apart from every other
   * skip because it is the only one the user can do something about, and the
   * thing they do about it (the `needs_review` chip) is a different destination.
   */
  needsReview: number
  /** Every other refusal, collapsed: no domain, already dismissed, an error. */
  skippedOther: number
  /** The enrollment that followed this save, when there was one. */
  enrolled: { count: number; sequenceId: string; sequenceName: string | null } | null
  /** Who did it. Not rendered — see the docblock. */
  source: 'page' | 'scout'
  /** `Date.now()` when the story was made; the newer story wins. */
  at: number
}

/** "1 company" / "3 companies" — a count that agrees with its own noun. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The head clause: what landed in the CRM.
 *
 * ZERO CLAUSES ARE DROPPED, not rendered as "0 companies". A people-only save
 * reads "2 people added to your CRM", which is the true sentence; "0 companies
 * and 2 people" invites the reader to wonder which company failed.
 */
export function savedClause(story: SaveStory): string | null {
  const { companies, people } = story
  const what =
    companies > 0 && people > 0
      ? `${plural(companies, 'company', 'companies')} and ${plural(people, 'person', 'people')}`
      : companies > 0
        ? plural(companies, 'company', 'companies')
        : people > 0
          ? plural(people, 'person', 'people')
          : null
  if (!what) return null
  if (story.kind === 'saved') return `${what} saved to the list`
  const name = story.listName?.trim()
  return name ? `${what} added to your CRM under “${name}”` : `${what} added to your CRM`
}

export function SaveStoryBanner({
  story,
  onOpenSaved,
  onOpenNeedsReview,
  onOpenSequence,
  onPublish,
  onDismiss,
}: {
  story: SaveStory
  /** Show the rows that landed — the `saved` chip. */
  onOpenSaved: () => void
  /** Show the people held back — the `needs_review` chip. */
  onOpenNeedsReview: () => void
  /** Open the sequence they were enrolled into. The one link on this page that
   *  is a REAL tab navigation, because a sequence is its own page. */
  onOpenSequence: (sequenceId: string, sequenceName: string | null) => void
  /** A `saved` story's next step: the rows are on the list, not in the CRM
   *  yet. Rendered only when given — Scout's saves and the page's share it. */
  onPublish?: () => void
  onDismiss: () => void
}) {
  const saved = savedClause(story)
  const enrolled = story.enrolled
  // A story with nothing in it is not a story. This can only happen if a save
  // returned entirely refusals AND had no skips either, which the route does
  // not do — but a banner that renders an empty sentence is worse than none.
  if (!saved && !enrolled && story.needsReview === 0 && story.skippedOther === 0) return null

  return (
    <div
      role="status"
      data-save-story={story.source}
      className="mx-5 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
    >
      {saved && (
        <button
          type="button"
          onClick={onOpenSaved}
          className="rounded text-foreground underline-offset-2 hover:underline"
        >
          {saved}
        </button>
      )}
      {enrolled && (
        <>
          {saved && <span aria-hidden>·</span>}
          {/* A sequence whose NAME did not come back is still a real
              destination — the link works, it just cannot be named. A missing
              ID is not: Scout's extractor falls back to '' when an enroll
              output carries no sequence_id, and routing on that would land the
              user on a blank sequence page. The enrollment still happened, so
              it is still reported — as plain text, with no doorway that leads
              nowhere. */}
          {enrolled.sequenceId ? (
            <button
              type="button"
              onClick={() => onOpenSequence(enrolled.sequenceId, enrolled.sequenceName)}
              className="rounded text-foreground underline-offset-2 hover:underline"
            >
              {enrolled.count} enrolled in {enrolled.sequenceName ?? 'a sequence'}
            </button>
          ) : (
            <span className="text-foreground">
              {enrolled.count} enrolled in {enrolled.sequenceName ?? 'a sequence'}
            </span>
          )}
        </>
      )}
      {story.needsReview > 0 && (
        <>
          {(saved || enrolled) && <span aria-hidden>·</span>}
          <button
            type="button"
            onClick={onOpenNeedsReview}
            title="Their employer could not be verified — open them to confirm or dismiss"
            className="rounded underline-offset-2 hover:text-foreground hover:underline"
          >
            {story.needsReview} need review
          </button>
        </>
      )}
      {/* NOT a link: "skipped" collects unrelated refusals (no domain, already
          dismissed, a write that failed) with no single destination that would
          hold them all. Saying the number is honest; inventing a doorway to a
          set that does not exist is not. */}
      {story.skippedOther > 0 && (
        <>
          {(saved || enrolled || story.needsReview > 0) && <span aria-hidden>·</span>}
          <span>{story.skippedOther} skipped</span>
        </>
      )}
      {/* The doorway a SAVE opens: the rows are on the list, and the CRM
          will not see them until the list is published. */}
      {story.kind === 'saved' && saved && onPublish && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onPublish}
            title="Write the list's saved companies and people to the CRM, grouped under the list"
            className="rounded font-medium text-foreground underline-offset-2 hover:underline"
          >
            Publish to CRM
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-auto shrink-0 rounded px-1 text-muted-foreground/70 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
