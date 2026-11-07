// The live roadmap for MDX (`<RoadmapTimeline />` in content/docs/roadmap.mdx).
// An async server component: it fetches the same cached GitHub data as /roadmap.

import { getRoadmap } from '@/lib/roadmap/fetch'
import { RoadmapTimeline } from './roadmap-timeline'

export async function RoadmapEmbed() {
  const data = await getRoadmap()
  // not-prose: the docs body styles every link and heading; the cards keep their own look.
  return <RoadmapTimeline data={data} className="not-prose my-8" />
}
