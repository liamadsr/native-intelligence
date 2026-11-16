import { describe, expect, it } from 'vitest'
import { browserWatchRefusal, landedOnSignIn, normalizeWatchUrl, PAGE_WATCH_BROWSER_INTERVAL_MINUTES, watchIntervalMinutes, watchReadsInBrowser, PAGE_WATCH_INTERVAL_MINUTES, PAGE_WATCH_LOOK_FOR_MAX, PAGE_WATCH_MAX_PER_PERSON, PAGE_WATCH_URL_MAX } from '../url'

const ok = (raw: unknown) => {
  const out = normalizeWatchUrl(raw)
  expect(out, String(raw)).not.toBeInstanceOf(Error)
  return out as string
}
const refused = (raw: unknown) => {
  const out = normalizeWatchUrl(raw)
  expect(out, String(raw)).toBeInstanceOf(Error)
  return (out as Error).message
}

describe('normalizeWatchUrl', () => {
  it('keeps the settings the rest of the feature reads', () => {
    expect(PAGE_WATCH_INTERVAL_MINUTES).toBe(15)
    expect(PAGE_WATCH_MAX_PER_PERSON).toBe(20)
    expect(PAGE_WATCH_LOOK_FOR_MAX).toBe(300)
  })

  it('normalizes a public page: scheme added when missing, host lower case, fragment dropped, query kept', () => {
    expect(ok('https://Example.com/Pricing?plan=pro#faq')).toBe('https://example.com/Pricing?plan=pro')
    expect(ok('example.com/jobs')).toBe('https://example.com/jobs')
    expect(ok('  http://shop.example.org  ')).toBe('http://shop.example.org/')
    expect(ok('https://example.com:443/status')).toBe('https://example.com/status')
    expect(ok('http://example.com:80/status')).toBe('http://example.com/status')
    expect(ok('https://93.184.215.14/')).toBe('https://93.184.215.14/')
    expect(ok('https://[2606:4700::1111]/')).toBe('https://[2606:4700::1111]/')
  })

  it('refuses what is not an address, with words a person can read', () => {
    expect(refused(undefined)).toBe('Give the address of the page to watch.')
    expect(refused('   ')).toBe('Give the address of the page to watch.')
    expect(refused('not a url')).toBe('That does not look like a web address.')
    expect(refused('https://')).toBe('That does not look like a web address.')
    expect(refused(`https://example.com/${'a'.repeat(PAGE_WATCH_URL_MAX)}`)).toBe('That address is too long.')
  })

  it('refuses other schemes and credentials', () => {
    for (const raw of ['ftp://example.com/file', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
      expect(refused(raw)).toMatch(/Only web pages|does not look like/)
    }
    expect(refused('https://user:secret@example.com/')).toMatch(/user name and password/)
  })

  it('refuses names and addresses on a private network or this machine', () => {
    for (const raw of [
      'http://localhost:3000/',
      'http://LOCALHOST./',
      'http://app.localhost/',
      'http://printer.local/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/',
      'http://router.home.arpa/',
      'http://intranet/',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0/',
    ]) {
      expect(refused(raw)).toMatch(/private network/)
    }
  })

  it('refuses any port but the usual one, in plain words', () => {
    expect(refused('example.com:8080/status')).toBe("That address names port 8080. Only pages on a website's usual address (no port) can be watched.")
    expect(refused('https://example.com:80/')).toMatch(/names port 80\./)
    expect(refused('http://example.com:443/')).toMatch(/names port 443\./)
    expect(refused('http://example.com:22/')).toMatch(/names port 22\./)
  })

  it('refuses an address in disguise', () => {
    expect(refused('http://2130706433/')).toMatch(/private network|does not look like/)
    expect(refused('http://0x7f.1/')).toMatch(/private network|does not look like/)
  })
})

describe('reading in the person\'s browser', () => {
  it('a trigger asks for the browser only with read_with "browser", and is then read every 30 minutes', () => {
    expect(watchReadsInBrowser({ url: 'https://example.com/', read_with: 'browser' })).toBe(true)
    for (const cfg of [null, undefined, 'browser', {}, { read_with: 'fetch' }, { read_with: true }]) expect(watchReadsInBrowser(cfg)).toBe(false)
    expect(watchIntervalMinutes({ read_with: 'browser' })).toBe(PAGE_WATCH_BROWSER_INTERVAL_MINUTES)
    expect(watchIntervalMinutes({})).toBe(PAGE_WATCH_INTERVAL_MINUTES)
    expect(PAGE_WATCH_BROWSER_INTERVAL_MINUTES).toBe(30)
  })

  it('a social network\'s signed-in pages are never read in the browser; other sites are', () => {
    for (const url of ['https://www.linkedin.com/messaging/', 'https://x.com/messages', 'https://m.facebook.com/', 'https://www.instagram.com/direct/inbox/']) {
      expect(browserWatchRefusal(url)).toMatch(/does not allow its signed-in pages to be read automatically/)
    }
    expect(browserWatchRefusal('https://app.example.com/orders')).toBeNull()
    // A name that only ends like one is another site.
    expect(browserWatchRefusal('https://notlinkedin.com/')).toBeNull()
    expect(browserWatchRefusal('https://example.com/x.com')).toBeNull()
  })

  it('a landing on a sign-in page is told from the page that was asked for', () => {
    const asked = 'https://app.example.com/orders'
    expect(landedOnSignIn(asked, 'https://app.example.com/login?next=%2Forders')).toBe(true)
    expect(landedOnSignIn(asked, 'https://app.example.com/users/sign_in')).toBe(true)
    expect(landedOnSignIn(asked, 'https://app.example.com/users/sign-in')).toBe(true)
    expect(landedOnSignIn(asked, 'https://login.example.com/?return=orders')).toBe(true)
    expect(landedOnSignIn(asked, 'https://accounts.example.com/o/oauth2/auth')).toBe(true)
    // The page itself, a harmless redirect, and words that only contain "auth" or "sign".
    expect(landedOnSignIn(asked, asked)).toBe(false)
    expect(landedOnSignIn(asked, 'https://app.example.com/orders/')).toBe(false)
    expect(landedOnSignIn(asked, 'https://app.example.com/authors/signals')).toBe(false)
    // A watch ON a sign-in page is not a sign-out.
    expect(landedOnSignIn('https://app.example.com/login', 'https://app.example.com/login/sso')).toBe(false)
    expect(landedOnSignIn('not a url', asked)).toBe(false)
  })
})
