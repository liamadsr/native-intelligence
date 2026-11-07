import { NextResponse } from 'next/server'

// Build ID is set at build time — changes on every Vercel deployment
const BUILD_ID = process.env.VERCEL_DEPLOYMENT_ID
  ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8)
  ?? 'dev'

export async function GET() {
  return NextResponse.json(
    { buildId: BUILD_ID },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
  )
}
