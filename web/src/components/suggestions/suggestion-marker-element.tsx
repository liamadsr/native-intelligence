'use client'

/**
 * What a `<!-- proposal:ID -->` marker renders as in react-markdown
 * (remark-suggestion-markers.ts): the suggestion's card. A block element, so
 * the plugin keeps it out of paragraphs.
 *
 * Off on a public surface (EntityRefsProvider enabled={false}). Only a full
 * uuid is looked up: the 8-character short ids and sort indexes the
 * capture page's TipTap parser also accepts mean nothing outside that capture.
 */
import { SuggestionCard } from './suggestion-card'
import { useEntityRefsEnabled } from '@/components/entity-refs/entity-refs-context'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function SuggestionMarkerElement(props: Record<string, unknown>) {
  // A public surface (the share page) turns live workspace features off: the
  // marker then renders nothing instead of calling the authenticated routes.
  const live = useEntityRefsEnabled()
  const id = (props['data-suggestion-id'] ?? props.dataSuggestionId) as string | undefined
  if (!live || !id || !UUID_RE.test(id)) return null
  return <SuggestionCard id={id} />
}
