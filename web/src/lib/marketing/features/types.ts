/**
 * What a feature's deep-dive page (/features/<slug>) is made of. One file per
 * feature sits beside this one; ./index.ts lists them in the side panel's
 * order.
 *
 * NOTHING HERE CLAIMS WHAT THE PRODUCT LACKS. Every sentence describes what
 * is live in production today. People and companies in examples are made up.
 */

/** A live demo from components/landing/lazy-demos.tsx, by name. */
export type FeatureDemoKey =
  | 'chat'
  | 'live-agent'
  | 'action-stream'
  | 'execution'
  | 'crm-autolog'
  | 'intelligence-loop'
  | 'capture'
  | 'notes-doc'
  | 'speaker-id'
  | 'hud-tips'
  | 'context-package'

/**
 * The feature's recorded walkthrough. Leave it out until the video exists:
 * the page then opens on `demo` instead (or on nothing), never on an empty
 * player.
 */
export interface FeatureVideo {
  /** A file under public/ (e.g. `/videos/features/mail.mp4`) or a full URL. */
  src: string
  /** The still shown before play. */
  poster?: string
  /** As shown beside the play button, e.g. `1:42`. */
  length?: string
}

export interface FeatureSection {
  /** The section's anchor, kebab-case, unique on its page. */
  id: string
  /** Its short name in the page's "On this page" list (one to three words). */
  nav: string
  /** The heading: a short sentence that ends with a full stop. */
  title: string
  /** Two or three plain sentences. */
  body: string
  /** Optional short lines under the body, three to five of them. */
  points?: string[]
  /** Optional live demo under the text. Use each demo at most once per page. */
  demo?: FeatureDemoKey
}

export interface FeaturePage {
  /** The URL segment: /features/<slug>. */
  slug: string
  /** The name in the side panel (one or two words). */
  name: string
  /** The headline: one short sentence that ends with a full stop. */
  title: string
  /** One or two sentences under the headline. */
  lead: string
  /** The line under the button, e.g. "Works with Gmail and Outlook". */
  worksWith?: string
  /** Under 60 characters; the layout appends " - Native Intelligence". */
  metaTitle: string
  /** Under 160 characters. */
  metaDescription: string
  /** Two short paragraphs after the opening: why this exists, what it joins up. */
  intro: string[]
  /** What the page opens on while there is no video. */
  demo?: FeatureDemoKey
  video?: FeatureVideo
  /** Five to eight sections. */
  sections: FeatureSection[]
  /** Three to five questions a buyer would really ask. */
  faq: { q: string; a: string }[]
  /** Slugs of two or three features this one works with. */
  related: string[]
}
