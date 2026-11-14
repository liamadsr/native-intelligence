import { NextResponse } from 'next/server'

// The build id: the commit the build was made from (as next.config.mjs's
// BUILD_ID), so it changes with every roll-out. 'dev' in a build without one.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? 'dev'

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
