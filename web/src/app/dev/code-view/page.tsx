import { notFound } from 'next/navigation'
import CodeViewFixtureLoader from './loader'

/**
 * The Code view from fixtures — DEV ONLY (`notFound()` in production, like
 * /dev/local-agent). Draws a coding chat's conversation (the panel's own
 * rows: steps, an update, events, the branch, a pull request) and the right
 * panel's cards (Action, Status, Review, Changes, Environment) from made-up
 * data, with no Mac and no session, so the view's look can be checked and
 * screenshotted: `?theme=dark` for the dark theme, `?view=new` for an empty
 * coding chat. scripts/code-view-screenshots.mjs takes the screenshots.
 */
export const metadata = {
  robots: { index: false },
}

export default function CodeViewFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <CodeViewFixtureLoader />
}
