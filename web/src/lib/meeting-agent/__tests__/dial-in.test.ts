import { describe, expect, it } from 'vitest'
import { dialDigits, dialInOfEvent, dialInOfGoogleEntryPoints, dialInOfMicrosoftOnlineMeeting, dialInOfText, isDialDigits } from '@/lib/meeting-agent/dial-in'

describe('dial digits per platform', () => {
  it('Meet and Teams: wait for the answer, then the id and #', () => {
    expect(dialDigits('meet', '123 456 789')).toBe('wwwwww123456789#')
    expect(dialDigits('teams', '987654321#')).toBe('wwwwww987654321#')
  })
  it('Zoom: the meeting id, then * passcode #, or # alone with no passcode', () => {
    expect(dialDigits('zoom', '812 3456 7890', '123456')).toBe('wwwwww81234567890#wwwwwwww*123456#')
    expect(dialDigits('zoom', '812 3456 7890')).toBe('wwwwww81234567890#wwwwwwww#')
  })
  it('refuses an id too short or too long, and anything not DTMF', () => {
    expect(dialDigits('meet', '12')).toBeNull()
    expect(dialDigits('meet', '1'.repeat(21))).toBeNull()
    expect(isDialDigits('wwww123#')).toBe(true)
    expect(isDialDigits('123;rm')).toBe(false)
    expect(isDialDigits('')).toBe(false)
  })
})

describe("the providers' own fields", () => {
  it("Google: the phone entry point's tel: uri and pin", () => {
    const eps = [
      { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
      { entryPointType: 'phone', uri: 'tel:+1-555-555-0142', pin: '123456789' },
    ]
    expect(dialInOfGoogleEntryPoints(eps)).toEqual({ number: '+15555550142', digits: 'wwwwww123456789#', platform: 'meet' })
  })
  it('Google: no phone entry, or one outside the US and Canada, is none', () => {
    expect(dialInOfGoogleEntryPoints([{ entryPointType: 'video', uri: 'https://meet.google.com/x' }])).toBeNull()
    expect(dialInOfGoogleEntryPoints([{ entryPointType: 'phone', uri: 'tel:+44-20-7946-0958', pin: '123456789' }])).toBeNull()
    expect(dialInOfGoogleEntryPoints(undefined)).toBeNull()
  })
  it("Teams: the onlineMeeting's toll number and conference id", () => {
    expect(dialInOfMicrosoftOnlineMeeting({ joinUrl: 'https://teams.microsoft.com/l/x', tollNumber: '+1 555-555-0143', conferenceId: '987654321' })).toEqual({
      number: '+15555550143',
      digits: 'wwwwww987654321#',
      platform: 'teams',
    })
    expect(dialInOfMicrosoftOnlineMeeting({ joinUrl: 'https://teams.microsoft.com/l/x' })).toBeNull()
    expect(dialInOfMicrosoftOnlineMeeting(null)).toBeNull()
  })
})

describe("an invite's text", () => {
  it("Zoom's one tap, with its passcode", () => {
    const text = 'Join Zoom Meeting\nhttps://zoom.us/j/81234567890\n\nOne tap mobile\n+15555550144,,81234567890#,,,,*123456# US'
    expect(dialInOfText(text)).toEqual({ number: '+15555550144', digits: 'wwwwww81234567890#wwwwwwww*123456#', platform: 'zoom' })
  })
  it("Zoom's dial by location, meeting id and passcode", () => {
    const text = 'Join Zoom Meeting https://zoom.us/j/81234567890\nMeeting ID: 812 3456 7890\nPasscode: 654321\nDial by your location\n        +1 555 555 0145 US (New York)'
    expect(dialInOfText(text)).toEqual({ number: '+15555550145', digits: 'wwwwww81234567890#wwwwwwww*654321#', platform: 'zoom' })
  })
  it("Teams' text: number and phone conference id", () => {
    const text = 'Microsoft Teams meeting\nJoin on your computer\nOr call in (audio only)\n+1 555-555-0146,,123456789# United States\nPhone Conference ID: 123 456 789#'
    expect(dialInOfText(text)).toEqual({ number: '+15555550146', digits: 'wwwwww123456789#', platform: 'teams' })
  })
  it("Meet's text: number and PIN", () => {
    const text = 'Join with Google Meet: https://meet.google.com/abc-defg-hij\nJoin by phone\n(US) +1 555-555-0147 PIN: 123 456 789#'
    expect(dialInOfText(text)).toEqual({ number: '+15555550147', digits: 'wwwwww123456789#', platform: 'meet' })
  })
  it('a number with no meeting id, no number, or a number abroad is none', () => {
    expect(dialInOfText('Call me at +1 555 555 0148 if you are late')).toBeNull()
    expect(dialInOfText('Meeting ID: 812 3456 7890')).toBeNull()
    expect(dialInOfText('Zoom Meeting ID: 812 3456 7890 +44 20 7946 0958')).toBeNull()
    expect(dialInOfText(null)).toBeNull()
  })
  it("an event: the provider's own dial-in first, then the description, then the location", () => {
    const own = { number: '+15555550149', digits: 'wwwwww111111#', platform: 'meet' as const }
    expect(dialInOfEvent({ dialIn: own, description: 'PIN: 222 222# +1 555 555 0150' })).toBe(own)
    expect(dialInOfEvent({ description: 'Google Meet +1 555 555 0150 PIN: 222 222#' })?.number).toBe('+15555550150')
    expect(dialInOfEvent({ description: '', location: 'Google Meet +1 555 555 0151 PIN: 333 333#' })?.number).toBe('+15555550151')
  })
})
