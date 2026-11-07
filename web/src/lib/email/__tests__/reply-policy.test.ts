import { describe, expect, it } from 'vitest'
import { hasOnlyNoReplyDestination, isNoReplyAddress, mailboxAddresses, replyRecipients } from '../reply-policy'
import { formatMailbox } from '../mailbox-header'

describe('reply address policy', () => {
  it('parses and deduplicates actual mailboxes while preserving quoted comma display names', () => {
    expect(mailboxAddresses('"Doe, Jane" <JANE@example.com>, Sam <sam@example.com>, jane@example.com')).toEqual(['jane@example.com', 'sam@example.com'])
    expect(mailboxAddresses('"No-reply@example.com" <human@example.com>')).toEqual(['human@example.com'])
  })

  it.each(['Alex <Support>', 'Alex <Support>, "Lead"', 'Alex \\ Team <Operations>', 'No Reply <noreply@example.com>'])('round-trips the provider display name without losing or inventing recipients: %s', name => {
    const header = formatMailbox(name, 'alex@example.com')
    expect(mailboxAddresses(header)).toEqual(['alex@example.com'])
    expect(replyRecipients({ from: header })).toEqual(['alex@example.com'])
    expect(replyRecipients({ from: 'no-reply@example.com', replyTo: header })).toEqual(['alex@example.com'])
    expect(hasOnlyNoReplyDestination({ from: header })).toBe(false)
  })

  it.each([
    '', 'not an address', 'person@@example.com', 'person@example.com\r\nBcc: attacker@example.com',
    'Person <person@example.com', 'Person person@example.com>', '"Unclosed <person@example.com>',
    'person@example.com,,another@example.com', 'person@example.com trailing',
    'person@example..com', 'person@-example.com', 'person@example-.com',
    'Person <person@example.com> <other@example.com>',
    'Person <person@example.com><other@example.com>',
    '"Display <inside>" <person@example.com> <other@example.com>',
  ])('refuses malformed or unsupported mailbox headers without guessing: %s', header => {
    expect(mailboxAddresses(header)).toEqual([])
    expect(isNoReplyAddress(header)).toBe(false)
  })

  it.each([
    'noreply@example.com', 'no-reply@example.com', 'no_reply@example.com', 'no.reply@example.com',
    'do-not-reply@example.com', 'do_not_reply@example.com', 'donotreply@example.com',
    'noreply123@example.com', 'no-reply+ticket@example.com', 'alerts+noreply@example.com',
    'mailer-daemon@example.com', 'postmaster@example.com', 'notice@no-reply.example.com',
    'No Reply Team <NO-REPLY@example.com>',
  ])('recognizes no-reply destination %s', header => {
    expect(isNoReplyAddress(header)).toBe(true)
    expect(hasOnlyNoReplyDestination({ from: header })).toBe(true)
    expect(replyRecipients({ from: header })).toEqual([])
  })

  it.each([
    'No Reply <human@example.com>', '"noreply@example.com" <human@example.com>',
    'reply@example.com', 'person@notnoreply.example.com', 'replyhq-founder@example.com', 'reply.to.sam@example.com',
  ])('does not confuse display names or unrelated addresses with no-reply: %s', header => {
    expect(isNoReplyAddress(header)).toBe(false)
  })

  it.each([
    'gustonoreply@gusto.com', 'alerts-noreply@example.com', 'NOREPLYING@example.com', 'billing_donotreply@example.com',
    'please.do.not.reply@example.com', 'notreply@example.com', 'bounces+abc123@example.com', 'mailer.daemon@example.com',
  ])('recognizes a no-reply marker anywhere in the local part: %s', header => {
    expect(isNoReplyAddress(header)).toBe(true)
    expect(replyRecipients({ from: header })).toEqual([])
  })

  it('uses human Reply-To instead of suppressing a request from an automated forwarder', () => {
    const message = { from: 'Forms <no-reply@forms.example.com>', replyTo: 'Sam <sam@example.com>' }
    expect(hasOnlyNoReplyDestination(message)).toBe(false)
    expect(replyRecipients(message)).toEqual(['sam@example.com'])
  })

  it('honors an explicit no-reply Reply-To and filters mixed destinations without discarding the human', () => {
    expect(hasOnlyNoReplyDestination({ from: 'person@example.com', replyTo: 'no-reply@example.com' })).toBe(true)
    expect(replyRecipients({ from: 'person@example.com', replyTo: 'no-reply@example.com' })).toEqual([])
    const mixed = { from: 'no-reply@example.com', replyTo: 'no-reply@example.com, Person <person@example.com>' }
    expect(hasOnlyNoReplyDestination(mixed)).toBe(false)
    expect(replyRecipients(mixed)).toEqual(['person@example.com'])
    expect(hasOnlyNoReplyDestination({ from: 'no-reply@example.com, donotreply@example.com' })).toBe(true)
  })

  it('does not fall back to From when a supplied Reply-To is malformed', () => {
    const message = { from: 'no-reply@example.com', replyTo: 'broken header' }
    expect(hasOnlyNoReplyDestination(message)).toBe(false)
    expect(replyRecipients(message)).toEqual([])
    expect(replyRecipients({ from: 'human@example.com', replyTo: ' \t ' })).toEqual(['human@example.com'])
  })
})
