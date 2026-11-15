import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { formGateDeps } from '@/lib/forms/deps'
import { isInviteTokenShape } from '@/lib/forms/invites'
import { formShape, openForm, type FormGate } from '@/lib/forms/public'
import { getServiceClient } from '@/lib/supabase/service'
import { FormView, type FormPageState } from './form-view'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null

/** The link read once per request, for the title and the page alike. */
const load = cache((key: string, invite: string | null): Promise<FormGate> => openForm(key, invite, formGateDeps(getServiceClient())))

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { key } = await params
  const gate = await load(key, first((await searchParams).i)).catch(() => null)
  const open = gate?.kind === 'open' ? gate.form : null
  return {
    title: { absolute: open?.name ?? 'Form' },
    description: open?.description ?? null,
    // One business's form: out of the search index, and its link (the key in the address) out of any Referer.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  }
}

/**
 * A form's own page (forms phase 3): the form drawn from its fields, posted
 * to its intake link (src/lib/forms/submit.ts). The key in the address is
 * the form's publishable key, or a personal link's secret. A wrong one is
 * not found; a members form asks a signed-out visitor to sign in first;
 * anything else that can't be filled in is one plain line.
 */
export default async function FormPage({ params, searchParams }: Props) {
  const { key } = await params
  const invite = first((await searchParams).i)
  let gate: FormGate
  try {
    gate = await load(key, invite)
  } catch {
    return <FormView state={{ kind: 'unavailable' }} />
  }
  if (gate.kind === 'missing') notFound()
  // The page itself comes back after signing in. Its key rides the address, as it does here.
  if (gate.kind === 'signed_out') redirect(`/login?redirect=${encodeURIComponent(`/f/${key}`)}`)
  let state: FormPageState
  if (gate.kind === 'open') {
    // A personal link's secret in the address is the one the post claims; beside a form's key it rides the post.
    state = { kind: 'open', link: key, invite: isInviteTokenShape(key) ? null : gate.invite, shape: formShape(gate.form, gate.columns) }
  } else {
    state = { kind: gate.kind }
  }
  return <FormView state={state} />
}
