/**
 * The MCP SSRF guard's hardening (F2 review S6): every IPv6 spelling of a
 * private IPv4 address, the IPv4-compatible and NAT64 ranges, a trailing dot,
 * a name whose DNS answer is private, a redirect, and a metadata body that
 * never ends. No test touches real DNS or the network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { assertSafeMcpUrl, ipv6Groups, isPrivateOrLocalIPv6, isPublicAddress } from '../url-guard'
import { assertPublicHost } from '../url-guard-dns'
import { readJsonCapped } from '../oauth'

describe('IPv6 literals', () => {
  it('reads the hex form a URL parser normalises an IPv4-mapped address to', () => {
    expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]')
    expect(ipv6Groups('[::ffff:7f00:1]')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    for (const host of ['[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[::ffff:a00:5]', '::ffff:192.168.1.1']) {
      expect(isPrivateOrLocalIPv6(host), host).toBe(true)
    }
    expect(isPrivateOrLocalIPv6('[::ffff:5db8:d822]')).toBe(false) // 93.184.216.34
  })

  it('blocks ::/96, 64:ff9b::/96, ULA, link-local, site-local and multicast', () => {
    for (const host of ['::', '::1', '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::808:808', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1']) {
      expect(isPrivateOrLocalIPv6(host), host).toBe(true)
    }
    expect(isPrivateOrLocalIPv6('2606:4700::1111')).toBe(false)
  })

  it('the URL guard refuses each of them, and a trailing-dot name', () => {
    for (const url of ['https://[::ffff:7f00:1]/mcp', 'https://[::ffff:a9fe:a9fe]/latest', 'https://[64:ff9b::a9fe:a9fe]/', 'https://metadata.google.internal./', 'https://169.254.169.254./']) {
      expect(assertSafeMcpUrl(url).ok, url).toBe(false)
    }
    expect(assertSafeMcpUrl('https://mcp.linear.app/mcp').ok).toBe(true)
  })
})

describe('special-use ranges (RFC 6890): never a public address', () => {
  it('IPv4: multicast, reserved and broadcast, documentation, benchmarking, IETF', () => {
    for (const ip of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.2.10', '198.51.100.7', '203.0.113.9', '198.18.0.1', '198.19.255.1', '192.0.0.8']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
    for (const ip of ['93.184.216.34', '192.0.1.1', '198.20.0.1', '203.0.114.1', '223.255.255.1']) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })

  it('IPv6: only global unicast (2000::/3), less Teredo, documentation and 6to4', () => {
    for (const ip of ['64:ff9b:1::a00:5', '100::1', '2001::1', '2001:0:4136:e378::1', '2001:db8::1', '2002:7f00:1::1', '4000::1', '::ffff:0:a00:5']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
    for (const ip of ['2606:4700::1111', '2a00:1450:4001::200e', '2001:4860:4860::8888', '3fff::1']) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })
})

describe('assertPublicHost (injected DNS)', () => {
  it('passes a name whose every address is public', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }])
    expect(await assertPublicHost('https://mcp.example.com/mcp', lookup)).toEqual({ ok: true })
    expect(lookup).toHaveBeenCalledWith('mcp.example.com')
  })

  it('refuses a name with ANY private answer, an empty answer or a failed lookup', async () => {
    expect((await assertPublicHost('https://rebind.example/mcp', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }])).ok).toBe(false)
    expect((await assertPublicHost('https://rebind.example/mcp', async () => [{ address: '::ffff:169.254.169.254' }])).ok).toBe(false)
    expect((await assertPublicHost('https://none.example/mcp', async () => [])).ok).toBe(false)
    expect(
      (
        await assertPublicHost('https://nx.example/mcp', async () => {
          throw new Error('ENOTFOUND')
        })
      ).ok,
    ).toBe(false)
  })

  it('a literal address is judged as itself, with no lookup', async () => {
    const lookup = vi.fn()
    expect((await assertPublicHost('https://[::ffff:7f00:1]/', lookup)).ok).toBe(false)
    expect((await assertPublicHost('https://93.184.216.34/', lookup)).ok).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
    expect(isPublicAddress('not-an-ip')).toBe(false)
  })
})

describe('readJsonCapped', () => {
  it('reads a small body and refuses a big one, declared or streamed', async () => {
    expect(await readJsonCapped(new Response('{"a":1}'))).toEqual({ a: 1 })
    await expect(readJsonCapped(new Response('{}', { headers: { 'content-length': '5000000' } }))).rejects.toThrow(/too large/)
    const endless = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    await expect(readJsonCapped(new Response(endless), 256 * 1024)).rejects.toThrow(/too large/)
  })
})
