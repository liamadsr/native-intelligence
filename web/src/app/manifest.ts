import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Native Intelligence — Turn conversations into action',
    short_name: 'NI',
    description:
      'Native Intelligence captures your meetings, keeps your projects updated automatically, and lets AI agents execute the work.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      {
        src: '/brand/ni-mark.png',
        sizes: '1024x1024',
        type: 'image/png',
      },
      {
        src: '/brand/ni-app-icon.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
