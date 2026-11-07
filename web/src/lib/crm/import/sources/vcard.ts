/**
 * Phone contacts as import records (roadmap track G1): a vCard file (.vcf)
 * an iPhone or Android shares, one card or thousands, versions 2.1, 3.0 and
 * 4.0. Pure.
 *
 * Read: FN and N (names), EMAIL, TEL, ADR (one line), ORG, TITLE, NOTE,
 * CATEGORIES (tags), UID (the source id, so the same card imports to the same
 * contact twice). Folded lines, escapes, item groups ("item1.EMAIL") and 2.1's
 * quoted-printable values are handled. Photos and everything else are left
 * out.
 */
import { cleanText, formatAddress, splitTags, type ImportContactRecord } from '../record'

/** The most cards one file imports. */
export const MAX_CARDS = 20_000

interface Property {
  name: string
  params: Record<string, string>
  value: string
}

/** Undo vCard text escaping: \n, \, \; and \\. */
function unescape(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** Split on an unescaped `;` (a structured value: N, ADR). */
function splitStructured(value: string): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1]
      i++
    } else if (ch === ';') {
      out.push(unescape(current))
      current = ''
    } else current += ch
  }
  out.push(unescape(current))
  return out
}

function decodeQuotedPrintable(value: string, charset = 'utf-8'): string {
  const bytes: number[] = []
  const text = value.replace(/=\r?\n/g, '')
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(...new TextEncoder().encode(text[i]))
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes))
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes)) // an unknown CHARSET label
  }
}

/** Unfold continuation lines (a leading space or tab) and 2.1's soft breaks. */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1)
    else if (out.length && /=$/.test(out[out.length - 1]) && /QUOTED-PRINTABLE/i.test(out[out.length - 1])) out[out.length - 1] = out[out.length - 1].slice(0, -1) + line
    else out.push(line)
  }
  return out
}

function parseLine(line: string): Property | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  const head = line.slice(0, colon)
  let value = line.slice(colon + 1)
  const [rawName, ...rawParams] = head.split(';')
  const name = rawName.replace(/^[^.]+\./, '').toUpperCase()
  const params: Record<string, string> = {}
  for (const p of rawParams) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1)
    else params.TYPE = params.TYPE ? `${params.TYPE},${p}` : p // 2.1: ";HOME;CELL"
  }
  if ((params.ENCODING ?? '').toUpperCase() === 'QUOTED-PRINTABLE') value = decodeQuotedPrintable(value, params.CHARSET || 'utf-8')
  return { name, params, value }
}

/** The cards in a vCard file, as contact records. */
export function parseVcards(text: string): ImportContactRecord[] {
  const records: ImportContactRecord[] = []
  let props: Property[] | null = null
  for (const line of unfold(text.replace(/^﻿/, ''))) {
    const upper = line.trim().toUpperCase()
    if (upper === 'BEGIN:VCARD') {
      props = []
      continue
    }
    if (upper === 'END:VCARD') {
      if (props) records.push(cardToRecord(props))
      props = null
      if (records.length >= MAX_CARDS) break
      continue
    }
    if (!props) continue
    const prop = parseLine(line)
    if (prop) props.push(prop)
  }
  return records
}

function cardToRecord(props: Property[]): ImportContactRecord {
  const all = (name: string) => props.filter((p) => p.name === name)
  const one = (name: string) => all(name)[0]
  const n = one('N') ? splitStructured(one('N')!.value) : []
  // Preferred values first (TYPE=pref or PREF=1).
  const preferred = (list: Property[]) => [...list].sort((a, b) => Number(isPref(b)) - Number(isPref(a)))
  const emails = preferred(all('EMAIL')).map((p) => unescape(p.value).trim())
  const phones = preferred(all('TEL')).map((p) => unescape(p.value).trim())
  const adr = one('ADR')
  const address = adr
    ? formatAddress((() => {
        // ADR: PO box; extended; street; locality; region; postal code; country.
        const [pobox, ext, street, city, region, postal, country] = splitStructured(adr.value)
        return [street, ext, pobox, city, region, postal, country]
      })())
    : null
  const org = one('ORG') ? splitStructured(one('ORG')!.value)[0] : null
  const notes = all('NOTE').map((p) => unescape(p.value).trim()).filter(Boolean)
  return {
    kind: 'contact',
    externalId: cleanText(one('UID')?.value, 300),
    fullName: one('FN') ? unescape(one('FN')!.value) : null,
    lastName: n[0] || null,
    firstName: n[1] || null,
    emails,
    phones,
    address,
    company: org ? { name: org } : null,
    jobTitle: one('TITLE') ? unescape(one('TITLE')!.value) : null,
    tags: all('CATEGORIES').flatMap((p) => splitTags(unescape(p.value))),
    notes: notes.length ? notes.join('\n') : null,
  }
}

function isPref(p: Property): boolean {
  return /\bpref\b/i.test(p.params.TYPE ?? '') || p.params.PREF === '1'
}

/** True when the text looks like a vCard file. */
export function looksLikeVcard(text: string): boolean {
  return /^\s*BEGIN:VCARD/im.test(text.slice(0, 2000))
}
