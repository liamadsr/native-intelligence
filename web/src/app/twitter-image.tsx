import { ImageResponse } from 'next/og'
import { appHost } from '@/lib/app-url'
import { HOME_TAGLINE } from './home-meta'

// Twitter card image — kept identical to opengraph-image.tsx. Duplicated rather
// than re-exported so this stays a self-contained metadata-image route (Next's
// file convention wants its own default export + config here). Generated at
// build time via next/og, font-fetch-free so it can't fail the build.

export const runtime = 'nodejs'
export const alt = 'Native Intelligence — The workspace that remembers everything'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function TwitterImage() {
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
            fontSize: 100,
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
          {HOME_TAGLINE}
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
