import { NextRequest, NextResponse } from 'next/server'
import {
  releases,
  getLatestRelease,
  formatReleaseTitle,
  getAllChangesFlat,
} from '@/data/releases'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const version = searchParams.get('version')

  const release = version
    ? releases.find((r) => r.version === version)
    : getLatestRelease()

  if (!release) {
    return new NextResponse('Release not found', { status: 404 })
  }

  const title = formatReleaseTitle(release)
  const changes = getAllChangesFlat(release)

  const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Dial8 ${release.version} Release Notes</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 20px;
            margin: 0;
            line-height: 1.6;
            background-color: #ffffff;
            color: #374151;
        }
        h1 {
            font-size: 24px;
            margin-top: 0;
            margin-bottom: 16px;
            color: #111827;
        }
        ul {
            line-height: 1.6;
            padding-left: 20px;
            margin: 0;
        }
        li {
            margin-bottom: 8px;
            color: #6b7280;
        }
        .warning {
            background-color: #fffbeb;
            border: 1px solid #fcd34d;
            border-radius: 8px;
            color: #92400e;
            padding: 12px 16px;
            margin-bottom: 20px;
            font-size: 14px;
            line-height: 1.5;
        }
        @media (prefers-color-scheme: dark) {
            body {
                background-color: #000000;
                color: #d1d5db;
            }
            h1 {
                color: #ffffff;
            }
            li {
                color: #9ca3af;
            }
            .warning {
                background-color: #451a03;
                border-color: #92400e;
                color: #fcd34d;
            }
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    ${release.warning ? `<div class="warning">⚠️ ${release.warning}</div>` : ''}
    <ul>
${changes.map((change) => `        <li>${change}</li>`).join('\n')}
    </ul>
</body>
</html>`

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  })
}
