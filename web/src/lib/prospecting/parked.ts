/**
 * IS THIS DOMAIN A LIVE SITE? — discovery's parked-domain gate.
 *
 * Exa's index remembers what a domain USED to host. On 2026-09-07 discovery
 * synthesized "Solenne Ventures (solenneventures.net)" from a stale page about a
 * wind-power developer, the account card scored the ghost 80 off the same
 * stale content, and the people search anchored to it still returned the real
 * firm's partners — who then sat under the ghost while the real row
 * (solennevc.co) reported "No people found yet" on every retry. The domain
 * itself is a HugeDomains for-sale page.
 *
 * So before discovery writes a candidate it asks the domain, not the index:
 * one GET of the root, following redirects. A domain is PARKED when it lands
 * on a known parking marketplace or its page says the domain is for sale;
 * DEAD when DNS has no answer at all. Both are refused as `invalid` with the
 * reason in the ledger row — nothing is silently dropped (§6). Anything else
 * (a 403 from a bot wall, a timeout, a certificate error) is UNKNOWN and the
 * candidate is admitted: a real company must never lose its row to a flaky
 * fetch. The check is a gate against a specific, observed failure, not a
 * liveness score.
 *
 * Injected into the engine as `deps.probeDomain` so no test touches the
 * network; the Inngest function passes {@link probeParkedDomain}.
 */

import { hostOf } from './evidence'

export type DomainProbeStatus = 'live' | 'parked' | 'dead' | 'unknown'

export interface DomainProbe {
  status: DomainProbeStatus
  /** Why, for the ledger — "redirects to hugedomains.com", "title: … for sale". */
  reason: string | null
}

export type DomainProber = (domain: string) => Promise<DomainProbe>

/** How long one probe may take. Discovery probes a whole angle's candidates
 *  in parallel, so this bounds the gate at a few seconds per angle. */
export const DOMAIN_PROBE_TIMEOUT_MS = 6_000

/** How much of a page is read looking for the for-sale notice. */
const BODY_CAP = 200_000

/**
 * Marketplaces a parked domain redirects to. Suffix-matched on the FINAL
 * host after redirects, so `www.hugedomains.com` and `sedo.com/search/…`
 * both count. GoDaddy is deliberately absent: its parking pages stay on the
 * parked host and say "parked free", which the body test catches.
 */
const PARKING_HOSTS = [
  'hugedomains.com',
  'sedo.com',
  'sedoparking.com',
  'dan.com',
  'afternic.com',
  'undeveloped.com',
  'parkingcrew.net',
  'bodis.com',
  'above.com',
  'squadhelp.com',
  'atom.com',
  'brandbucket.com',
  'domainmarket.com',
  'buydomains.com',
  'uniregistry.com',
  'epik.com',
  'dynadot.com',
  'parkingpage.namecheap.com',
  'namesilo.com',
]

/** A `<title>` that only a parking page has. */
const PARKED_TITLE =
  /\b(?:is|are)\s+for\s+sale\b|\bfor\s+sale\s*[|\-–—]|\bdomain(?:\s+name)?\s+(?:is\s+)?for\s+sale\b|\bparked\s+(?:free|domain)\b|\bdomain\s+parking\b|\bhugedomains\b|\bsedo\b|\bafternic\b|\bbuy\s+this\s+domain\b/i

/** A sentence in the body that only a parking page carries. Deliberately
 *  narrow: "domain" must be the subject, so a company blog post about buying
 *  domains does not trip it. */
const PARKED_BODY =
  /\b(?:this|the)\s+domain(?:\s+name)?\s+(?:is|may\s+be)\s+(?:for\s+sale|available)\b|\bbuy\s+this\s+domain\b|\bhugedomains\b|\bdomain\s+(?:is\s+)?parked\b|\bparked\s+free\b|\bparkingcrew\b|\bsedoparking\b|\bmake\s+an\s+offer\s+on\s+this\s+domain\b|\binquire\s+about\s+this\s+domain\b|\bthis\s+domain\s+is\s+for\s+sale\b/i

export function isParkingHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  return PARKING_HOSTS.some((p) => h === p || h.endsWith(`.${p}`))
}

/** The host to probe — scheme, path and `www.` stripped; null for junk. */
export function probeHost(domain: string): string | null {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

export async function probeParkedDomain(
  domain: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DomainProbe> {
  const host = probeHost(domain)
  if (!host) return { status: 'unknown', reason: 'no domain to probe' }
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DOMAIN_PROBE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`https://${host}/`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'user-agent': 'Mozilla/5.0 (compatible; Dial8Prospecting/1.0; +https://dial8.ai)',
      },
    })
    const landed = (res.url && hostOf(res.url)) || host
    if (isParkingHost(landed)) {
      return { status: 'parked', reason: `redirects to ${landed}` }
    }
    const body = await readSome(res, BODY_CAP)
    const title = titleOf(body)
    if (title && PARKED_TITLE.test(title)) {
      return { status: 'parked', reason: `title: ${title.slice(0, 80)}` }
    }
    if (PARKED_BODY.test(body)) {
      return { status: 'parked', reason: 'the page says the domain is for sale' }
    }
    return { status: 'live', reason: null }
  } catch (err) {
    if (isDnsFailure(err)) return { status: 'dead', reason: 'no DNS record' }
    return { status: 'unknown', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe many domains at once, a bounded number in flight. Every domain gets
 * an answer: a prober that throws yields `unknown`, never a rejected batch.
 */
export async function probeDomains(
  domains: Iterable<string | null | undefined>,
  probe: DomainProber,
  concurrency = 8,
): Promise<Map<string, DomainProbe>> {
  const unique = Array.from(
    new Set(Array.from(domains).filter((d): d is string => typeof d === 'string' && d.trim() !== '')),
  )
  const out = new Map<string, DomainProbe>()
  let next = 0
  const worker = async () => {
    while (next < unique.length) {
      const domain = unique[next++]
      try {
        out.set(domain, await probe(domain))
      } catch (err) {
        out.set(domain, {
          status: 'unknown',
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker))
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSome(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return (await res.text()).slice(0, cap)
  const decoder = new TextDecoder()
  let out = ''
  try {
    while (out.length < cap) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The stream is done with either way.
    }
  }
  return out.slice(0, cap)
}

function titleOf(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i)
  return m ? m[1].replace(/\s+/g, ' ').trim() || null : null
}

function isDnsFailure(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const rec = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (rec.code === 'ENOTFOUND') return true
    if (typeof rec.message === 'string' && /ENOTFOUND|getaddrinfo/.test(rec.message)) return true
    cur = rec.cause
  }
  return false
}
