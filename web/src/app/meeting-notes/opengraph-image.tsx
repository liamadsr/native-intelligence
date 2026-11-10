import { ImageResponse } from 'next/og'
import { appHost } from '@/lib/app-url'

// Social-card image for /meeting-notes: the site-wide card's design (see
// ../opengraph-image.tsx) with this pitch's headline as the tagline, so a
// shared link previews the meeting-notes pitch rather than the site-wide
// sales card. Self-contained like the root card routes, and font-fetch-free
// for the same reason: it cannot fail the build.

export const runtime = 'nodejs'
export const alt = 'Native Intelligence — Remarkably good meeting notes'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px 96px',
          background:
            'radial-gradient(120% 120% at 15% 0%, #1a1a1a 0%, #0f0f0f 55%, #0a0a0a 100%)',
          color: '#ededed',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        {/* Subtle accent bar echoing the product's minimal chrome */}
        <div
          style={{
            display: 'flex',
            width: 72,
            height: 6,
            borderRadius: 999,
            background: '#ededed',
            marginBottom: 44,
          }}
        />
        <div
          style={{
            display: 'flex',
            fontSize: 128,
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1,
          }}
        >
          Native Intelligence
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 32,
            fontSize: 48,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            color: '#a3a3a3',
            maxWidth: 900,
            lineHeight: 1.15,
          }}
        >
          Remarkably good meeting notes
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 'auto',
            fontSize: 28,
            color: '#737373',
            letterSpacing: '0.01em',
          }}
        >
          {appHost()}
        </div>
      </div>
    ),
    { ...size },
  )
}
