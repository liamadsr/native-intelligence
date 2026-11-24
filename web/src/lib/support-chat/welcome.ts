/**
 * Support chat's welcome (migration 715), pure and client-safe: the admin
 * page's form and preview read it, the admin route tidies with it.
 */

/** The welcome's longest template (715's check). */
export const SUPPORT_WELCOME_MAX = 2000

export interface SupportChatSettings {
  welcome_template: string
  sender_user_id: string | null
  updated_at: string | null
}

export interface SupportStaffRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  added_at: string
}

/** The welcome's words, tidied: trimmed, Windows line ends made plain; null when empty or too long. Pure. */
export function tidyWelcomeTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text || text.length > SUPPORT_WELCOME_MAX) return null
  return text
}

/**
 * The welcome as a person will read it, the database's rule
 * (support_chat_welcome_words): {name} is "@<their name>", {first_name}
 * their first word. Pure (the admin page's preview).
 */
export function welcomeWords(template: string, person: string): string {
  const name = person.trim() || 'there'
  return template.split('{name}').join(`@${name}`).split('{first_name}').join(name.split(' ')[0]).trim().slice(0, 8000)
}

