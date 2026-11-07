/**
 * Who a plan proxy call is for (src/app/api/internal/chatgpt-plan/v1/responses):
 * any eve agent's run, authenticated the way that agent authenticates to its
 * own internal routes. The agent's secret header names the family; the
 * family's secret and its verified, unexpired run token must both hold. The
 * token alone says whose plan pays.
 *
 * Header-only (never a `?token=` query fallback): one request names exactly
 * one family, and a token is never read from a URL that could be logged.
 */
import {
  CHAT_RUN_SECRET_HEADER,
  CHAT_RUN_TOKEN_HEADER,
  verifyChatRunToken,
  verifyInternalSecret as verifyChatSecret,
} from '@/lib/chat/chat-run-token'
import {
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
  verifyAgentRunToken,
  verifyInternalSecret as verifyAgentRunSecret,
} from '@/lib/agent-run/agent-run-token'
import {
  LIVE_AGENT_SECRET_HEADER,
  LIVE_AGENT_TOKEN_HEADER,
  verifyLiveAgentRunToken,
  verifyInternalSecret as verifyLiveAgentSecret,
} from '@/lib/live-agent/live-agent-run-token'
import {
  UTILITY_SECRET_HEADER,
  UTILITY_TOKEN_HEADER,
  verifyUtilityInternalSecret,
  verifyUtilityToken,
} from '@/lib/eve/utility-run-token'
import {
  RUN_SKILL_SECRET_HEADER,
  RUN_SKILL_TOKEN_HEADER,
  verifyRunToken as verifySkillRunToken,
  verifyInternalSecret as verifySkillRunSecret,
} from '@/lib/flows/skill-run-token'
import { getServiceClient } from '@/lib/admin'
import { chatRunBinding } from '@/lib/chat/surface-run-guard'
import { skillRunBinding } from '@/lib/flows/skill-run-binding'
import { loadLiveAgentTurnState } from '@/lib/live-agent/live-agent-spec'
import { PLAN_MODELS, planModelFromSlug } from './plan-models'

export type PlanCallerFamily = 'chat' | 'agent_run' | 'live_agent' | 'utility' | 'skill_run'

export interface PlanCaller {
  family: PlanCallerFamily
  userId: string
}

interface Family {
  family: PlanCallerFamily
  secretHeader: string
  tokenHeader: string
  verifySecret: (presented: string | null) => boolean
  /**
   * The verified token's person, or null (bad token, none to pay, or claims
   * that don't bind to live rows). Each family that has rows binds to them
   * (security review 2026-10-31, P0-1): an agent holds the secret that signs
   * its family's tokens, so the signature alone can't say whose plan pays.
   */
  userOf: (token: string | null) => Promise<string | null>
}

/** A member row for (user, workspace); false on absence or a failed read. */
async function isMember(userId: string, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await getServiceClient()
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ id: string }>()
    return !error && !!data
  } catch {
    return false
  }
}

/** An auth user with this id; false on absence or a failed read. */
async function userExists(userId: string): Promise<boolean> {
  try {
    const { data, error } = await getServiceClient().auth.admin.getUserById(userId)
    return !error && data.user?.id === userId
  } catch {
    return false
  }
}

const FAMILIES: readonly Family[] = [
  {
    family: 'chat',
    secretHeader: CHAT_RUN_SECRET_HEADER,
    tokenHeader: CHAT_RUN_TOKEN_HEADER,
    verifySecret: verifyChatSecret,
    userOf: async (t) => {
      const claims = verifyChatRunToken(t)
      if (!claims) return null
      return (await chatRunBinding(claims)) === 'bound' ? claims.userId : null
    },
  },
  {
    family: 'agent_run',
    secretHeader: AGENT_RUN_SECRET_HEADER,
    tokenHeader: AGENT_RUN_TOKEN_HEADER,
    verifySecret: verifyAgentRunSecret,
    // The run's row in the claimed workspace (as the work-run tool route
    // binds it), and the paying person a member of that workspace.
    userOf: async (t) => {
      const claims = verifyAgentRunToken(t)
      if (!claims) return null
      try {
        const { data: run, error } = await getServiceClient()
          .from('agent_run')
          .select('id')
          .eq('id', claims.agentRunId)
          .eq('workspace_id', claims.workspaceId)
          .maybeSingle<{ id: string }>()
        if (error || !run) return null
      } catch {
        return null
      }
      return (await isMember(claims.userId, claims.workspaceId)) ? claims.userId : null
    },
  },
  {
    family: 'live_agent',
    secretHeader: LIVE_AGENT_SECRET_HEADER,
    tokenHeader: LIVE_AGENT_TOKEN_HEADER,
    verifySecret: verifyLiveAgentSecret,
    // The same re-read the live-agent routes do: the capture, visible to a member.
    userOf: async (t) => {
      const claims = verifyLiveAgentRunToken(t)
      if (!claims) return null
      try {
        return (await loadLiveAgentTurnState(claims)) ? claims.userId : null
      } catch {
        return null
      }
    },
  },
  {
    family: 'utility',
    secretHeader: UTILITY_SECRET_HEADER,
    tokenHeader: UTILITY_TOKEN_HEADER,
    verifySecret: verifyUtilityInternalSecret,
    // As far as the claims allow (a utility task has no row of its own, and
    // carries no row id): a person (a workspace task with no owner has no
    // plan to run on), a token minted to run on the plan (runUtilityTask's
    // `chatgpt-plan/<model>`, never a Gateway call's), and the person a
    // member of the workspace it names. With no workspace, the person must
    // still exist. What stays open: a secret-holder can still name any
    // existing person with no workspace.
    userOf: async (t) => {
      const claims = verifyUtilityToken(t)
      if (!claims?.userId) return null
      const model = planModelFromSlug(claims.model)
      if (!model || !PLAN_MODELS.has(model)) return null
      if (claims.workspaceId) return (await isMember(claims.userId, claims.workspaceId)) ? claims.userId : null
      return (await userExists(claims.userId)) ? claims.userId : null
    },
  },
  {
    family: 'skill_run',
    secretHeader: RUN_SKILL_SECRET_HEADER,
    tokenHeader: RUN_SKILL_TOKEN_HEADER,
    verifySecret: verifySkillRunSecret,
    userOf: async (t) => {
      const claims = verifySkillRunToken(t)
      if (!claims) return null
      return (await skillRunBinding(claims)) === 'bound' ? claims.runAsUserId : null
    },
  },
]

/** The call's family and person, or null: no family, a bad secret, a bad token, or unbound claims. */
export async function planCallerFrom(request: Request): Promise<PlanCaller | null> {
  const family = FAMILIES.find((f) => request.headers.has(f.secretHeader))
  if (!family) return null
  if (!family.verifySecret(request.headers.get(family.secretHeader))) return null
  const userId = await family.userOf(request.headers.get(family.tokenHeader))
  return userId ? { family: family.family, userId } : null
}

/** The headers each family authenticates with, for the agents' plan models (drift-tested). */
export const PLAN_CALLER_HEADERS: Readonly<Record<PlanCallerFamily, { secret: string; token: string }>> = Object.fromEntries(
  FAMILIES.map((f) => [f.family, { secret: f.secretHeader, token: f.tokenHeader }]),
) as Record<PlanCallerFamily, { secret: string; token: string }>
