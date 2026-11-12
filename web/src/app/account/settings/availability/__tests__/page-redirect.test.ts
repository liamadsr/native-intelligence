/**
 * /account/settings/availability (../page.tsx): Availability left Settings
 * for its own page under Calendar (Liam, 11-11), so the old URL (the desktop
 * app, a bookmark, an email) redirects to the dashboard's `?page=` deep link,
 * which opens the Availability page's card.
 */
import { describe, expect, it, vi } from 'vitest'

const redirect = vi.fn()
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }))

import AvailabilitySettingsPage from '../page'

describe('the old Availability settings route', () => {
  it('redirects to the Availability page', () => {
    AvailabilitySettingsPage()
    expect(redirect).toHaveBeenCalledWith('/account?page=availability')
  })
})
