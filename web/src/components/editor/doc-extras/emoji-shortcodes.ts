/**
 * `:shortcode:` emoji (docs/plans/doc-editor-extras.md, phase 6): typing the
 * closing colon of `:tada:` puts 🎉 there. The names are the emoji data the
 * app already ships for its icon picker (@emoji-mart/data, MIT), loaded the
 * first time an editor with this extension is made; before it arrives, or
 * for a name it doesn't know, the text stays as typed. Backspace right after
 * undoes it, like any input rule.
 *
 * The opening colon must start a word (`10:30:00` and `https://` stay as they
 * are). Leaves `;` and `#` alone (other extensions own them).
 */
import { Extension, InputRule } from '@tiptap/core'

type EmojiData = {
  emojis: Record<string, { skins?: Array<{ native?: string }> }>
  aliases?: Record<string, string>
}

let table: Map<string, string> | null = null
let loading: Promise<void> | null = null

/** Build the name → emoji table from the data set. Pure. */
export function buildEmojiTable(data: EmojiData): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, e] of Object.entries(data.emojis)) {
    const native = e.skins?.[0]?.native
    if (native) out.set(id, native)
  }
  for (const [alias, id] of Object.entries(data.aliases ?? {})) {
    const native = out.get(id)
    if (native && !out.has(alias)) out.set(alias, native)
  }
  return out
}

/** Start loading the names (once). */
export function loadEmojiTable(): Promise<void> {
  if (table) return Promise.resolve()
  loading ??= import('@emoji-mart/data')
    .then((m) => {
      table = buildEmojiTable(((m as { default?: unknown }).default ?? m) as EmojiData)
    })
    .catch(() => {
      loading = null
    })
  return loading
}

/** For tests: use this table. */
export function __setEmojiTableForTests(t: Map<string, string> | null) {
  table = t
}

/** The emoji for a shortcode, when the names are loaded and know it. */
export function emojiFor(name: string): string | null {
  return table?.get(name.toLowerCase()) ?? null
}

export const EmojiShortcodes = Extension.create({
  name: 'niEmojiShortcodes',

  onCreate() {
    void loadEmojiTable()
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(^|[\s([{"'])(:([a-z0-9_+-]{1,50}):)$/i,
        handler: ({ state, range, match }) => {
          const emoji = emojiFor(match[3])
          if (!emoji) return null
          const start = range.from + match[1].length
          // Inside code, a colon pair is code.
          const $start = state.doc.resolve(start)
          if ($start.parent.type.spec.code || $start.marks().some((m) => m.type.spec.code)) return null
          state.tr.insertText(emoji, start, range.to)
        },
      }),
    ]
  },
})
