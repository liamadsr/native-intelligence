import {
  WORK_EMAIL_REQUIRED_ERROR_CODE,
  isWorkEmailRejection,
} from '@/lib/auth/work-email'

/**
 * Map the query string Supabase Auth sends to an OAuth callback WITHOUT a
 * `code` onto a `/login?error=` code.
 *
 * On failure Supabase redirects to the callback with `error`, `error_code`
 * and `error_description` instead of `code`. The only failure Dial8 names is
 * the work-email hook refusing a signup (the description carries the hook's
 * message verbatim) and an email link that expired or was already used;
 * everything else, including a bare missing `code`, keeps the generic
 * mapping the login page already knows.
 */
export function authCallbackErrorCode(params: URLSearchParams): string {
  if (!params.get('error')) return 'missing_code'
  if (isWorkEmailRejection(params.get('error_description'))) {
    return WORK_EMAIL_REQUIRED_ERROR_CODE
  }
  if (params.get('error_code') === 'otp_expired') return 'link_expired'
  return 'auth_failed'
}
