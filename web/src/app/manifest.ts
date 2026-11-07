import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Dial8 — Turn conversations into action',
    short_name: 'Dial8',
    description:
      'Dial8 captures your meetings, keeps your projects updated automatically, and lets AI agents execute the work.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      {
        src: '/screenshots/icon_128x128@2x 1.png',
        sizes: '256x256',
        type: 'image/png',
      },
      {
        src: '/screenshots/Icon-macOS-Dark-1024x1024@2x-dark.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
