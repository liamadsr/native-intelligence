import { permanentRedirect } from 'next/navigation'

// The sales pitch WAS this route, then the homepage; since 2026-11-14 the
// homepage pitches the whole workspace (src/app/workspace-page.tsx) and the
// sales pitch is retired. This route stays as a permanent redirect so the
// /sales links already in the wild — ads, docs, emails — keep working
// instead of 404ing.
export default function Page() {
  permanentRedirect('/')
}
