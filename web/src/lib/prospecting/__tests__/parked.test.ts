/**
 * The parked-domain probe (./parked) — discovery's gate against the ghost row.
 *
 * solenneventures.net answered 404 with a HugeDomains for-sale page while Exa's
 * index still described a wind-power developer; the row it became scored 80
 * and swallowed the real firm's partners. What is pinned here:
 *   - a landing on a parking marketplace, a for-sale title, or a for-sale
 *     sentence in the body is PARKED;
 *   - no DNS answer is DEAD;
 *   - everything the probe cannot decide — a bot wall, a hang-up, a timeout
 *     — is UNKNOWN, and the engine admits unknown. A real company must never
 *     lose its row to a flaky fetch.
 *   - the batch helper answers for every domain once, and a prober that
 *     throws yields unknown rather than a rejected batch.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  isParkingHost,
  probeDomains,
  probeHost,
  probeParkedDomain,
  type DomainProbe,
} from '../parked'

function page(html: string, init: { status?: number; url?: string } = {}): Response {
  const res = new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html' },
  })
  if (init.url) Object.defineProperty(res, 'url', { value: init.url })
  return res
}

const fetchWith = (res: Response | Error) =>
  vi.fn(async () => {
    if (res instanceof Error) throw res
    return res
  }) as unknown as typeof fetch

describe('probeParkedDomain', () => {
  it('calls the domain itself, once, over https, following redirects', async () => {
    const fetchImpl = fetchWith(page('<title>Solenne Ventures</title>'))
    await probeParkedDomain('www.solennevc.co/about?x=1', { fetch: fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://solennevc.co/')
    expect(init.redirect).toBe('follow')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('is LIVE for an ordinary site', async () => {
    const probe = await probeParkedDomain('solennevc.co', {
      fetch: fetchWith(page('<html><head><title>Solenne Ventures</title></head><body>Operator-led VC</body></html>')),
    })
    expect(probe).toEqual({ status: 'live', reason: null })
  })

  it('is PARKED when the site lands on a parking marketplace', async () => {
    const probe = await probeParkedDomain('solenneventures.net', {
      fetch: fetchWith(
        page('<title>Buy now</title>', { url: 'https://www.hugedomains.com/domain_profile.cfm?d=solenneventures.net' }),
      ),
    })
    expect(probe.status).toBe('parked')
    expect(probe.reason).toContain('hugedomains.com')
  })

  it('is PARKED on a for-sale title — even behind a 404, as HugeDomains serves it', async () => {
    const probe = await probeParkedDomain('solenneventures.net', {
      fetch: fetchWith(
        page('<html><head><title>SolenneVentures.net is for sale | HugeDomains</title></head></html>', {
          status: 404,
        }),
      ),
    })
    expect(probe.status).toBe('parked')
    expect(probe.reason).toContain('for sale')
  })

  it('is PARKED on a for-sale sentence in the body', async () => {
    const probe = await probeParkedDomain('example-parked.com', {
      fetch: fetchWith(
        page('<title>example-parked.com</title><p>This domain is parked free, courtesy of GoDaddy.</p>'),
      ),
    })
    expect(probe.status).toBe('parked')
  })

  it('does not mistake a company that merely talks about domains for a parked one', async () => {
    const probe = await probeParkedDomain('registrar.example', {
      fetch: fetchWith(
        page(
          '<title>Registrar Example — domains and hosting</title><p>Search for a domain name and buy it in seconds. Domain parking is one of our products.</p>',
        ),
      ),
    })
    expect(probe.status).toBe('live')
  })

  it('is DEAD when DNS has no answer', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), { code: 'ENOTFOUND' }),
    })
    const probe = await probeParkedDomain('gone.example', { fetch: fetchWith(err) })
    expect(probe).toEqual({ status: 'dead', reason: 'no DNS record' })
  })

  it('is UNKNOWN — and so admitted — for anything it cannot decide', async () => {
    expect((await probeParkedDomain('slow.example', { fetch: fetchWith(new Error('socket hang up')) })).status).toBe(
      'unknown',
    )
    // A bot wall answers 403 with a challenge page, not a for-sale notice.
    expect(
      (await probeParkedDomain('walled.example', { fetch: fetchWith(page('<title>Just a moment…</title>', { status: 403 })) }))
        .status,
    ).toBe('live')
    // Junk that is not a domain is not probed at all.
    expect((await probeParkedDomain('', { fetch: fetchWith(page('')) })).status).toBe('unknown')
  })

  it('aborts a probe that overruns the timeout, as unknown', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch
    const probe = await probeParkedDomain('hang.example', { fetch: hang, timeoutMs: 10 })
    expect(probe.status).toBe('unknown')
  })
})

describe('probeHost / isParkingHost', () => {
  it('normalises what discovery hands over', () => {
    expect(probeHost('https://www.Acme.com/path')).toBe('acme.com')
    expect(probeHost('acme.com')).toBe('acme.com')
    expect(probeHost('not a domain')).toBeNull()
    expect(probeHost('localhost')).toBeNull()
  })

  it('suffix-matches the marketplaces', () => {
    expect(isParkingHost('www.hugedomains.com')).toBe(true)
    expect(isParkingHost('sedo.com')).toBe(true)
    expect(isParkingHost('parkingpage.namecheap.com')).toBe(true)
    expect(isParkingHost('namecheap.com')).toBe(false)
    expect(isParkingHost('solennevc.co')).toBe(false)
  })
})

describe('probeDomains', () => {
  it('answers once per unique domain, a bounded number in flight, and never rejects', async () => {
    let inFlight = 0
    let peak = 0
    const probe = vi.fn(async (domain: string): Promise<DomainProbe> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight -= 1
      if (domain === 'boom.example') throw new Error('prober crashed')
      return { status: domain === 'parked.example' ? 'parked' : 'live', reason: null }
    })
    const out = await probeDomains(
      ['a.example', 'parked.example', 'a.example', null, undefined, '', 'boom.example', 'b.example'],
      probe,
      2,
    )
    expect(probe).toHaveBeenCalledTimes(4)
    expect(peak).toBeLessThanOrEqual(2)
    expect(out.get('parked.example')?.status).toBe('parked')
    expect(out.get('a.example')?.status).toBe('live')
    expect(out.get('boom.example')).toEqual({ status: 'unknown', reason: 'prober crashed' })
  })
})
