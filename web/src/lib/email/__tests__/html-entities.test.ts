/**
 * Gmail's snippet is HTML-escaped; previews are shown as text, so they are
 * decoded once (html-entities.ts): named and numeric entities, one pass, an
 * unknown or malformed one left as written.
 */
import { describe, expect, it } from 'vitest'
import { decodeEntitiesOrNull, decodeHtmlEntities } from '../html-entities'

describe('decodeHtmlEntities', () => {
  it('decodes the escapes Gmail writes', () => {
    expect(decodeHtmlEntities('it&#39;s &quot;fine&quot; &amp; done &lt;3 &gt;')).toBe('it\'s "fine" & done <3 >')
    expect(decodeHtmlEntities('won&#x27;t &#X27;x&#x27;')).toBe("won't 'x'")
    expect(decodeHtmlEntities('a&nbsp;b &hellip; &mdash;')).toBe('a b … —')
  })

  it('decodes once: an escaped entity stays an entity', () => {
    expect(decodeHtmlEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;')
  })

  it('leaves what is not an entity alone', () => {
    expect(decodeHtmlEntities('Q&A, AT&T; &unknown; &#0; &#xD800; & ;')).toBe('Q&A, AT&T; &unknown; &#0; &#xD800; & ;')
    expect(decodeHtmlEntities('plain text')).toBe('plain text')
    expect(decodeEntitiesOrNull(null)).toBeNull()
  })
})
