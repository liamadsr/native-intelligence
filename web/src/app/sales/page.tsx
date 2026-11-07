import { permanentRedirect } from 'next/navigation'

// The sales pitch WAS this route; it is now the homepage itself (see
// src/app/sales-page.tsx, rendered at `/`). This route stays as a permanent
// redirect so the /sales links already in the wild — ads, docs, emails sent
// before the pivot — keep working instead of 404ing, and so the pitch is not
// served as duplicate content at two URLs.
export default function Page() {
  permanentRedirect('/')
}
