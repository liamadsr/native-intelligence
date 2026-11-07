/**
 * The action as a self-contained prompt ("Copy as prompt" on the action
 * panel): the issue, its project repo, parent and sub-issues, PRs, recent
 * comments and links, in an XML-like shape any coding tool can take.
 */

export async function buildActionContext(actionId: string): Promise<{ prompt: string }> {
  const [actionRes, prsRes, commentsRes, subActionsRes] = await Promise.all([
    fetch(`/api/account/actions/${actionId}`),
    fetch(`/api/account/actions/${actionId}/prs`),
    fetch(`/api/account/actions/${actionId}/comments`),
    fetch(`/api/account/actions?parent_id=${actionId}`),
  ])

  const action = actionRes.ok ? (await actionRes.json()).action : null
  const prs = prsRes.ok ? (await prsRes.json()).prs ?? [] : []
  const comments = commentsRes.ok ? (await commentsRes.json()).comments ?? [] : []
  const subActions = subActionsRes.ok ? (await subActionsRes.json()).actions ?? [] : []

  if (!action) {
    return { prompt: 'The action item was not found.' }
  }

  // Fetch project repo info and parent action in parallel
  const [projectRepo, parentAction] = await Promise.all([
    action.project_id
      ? fetch(`/api/account/projects/${action.project_id}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => d?.project ? { github_repo: (d.project.github_repo as string | null) || null } : null)
          .catch(() => null)
      : Promise.resolve(null),
    action.parent_id
      ? fetch(`/api/account/actions/${action.parent_id}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => d?.action || null)
          .catch(() => null)
      : Promise.resolve(null),
  ])

  // --- Build structured prompt (XML-like format, similar to Linear) ---
  const lines: string[] = []

  lines.push(`Work on Dial8 issue ${action.identifier || actionId}:`)
  lines.push('')
  lines.push(`<issue identifier="${action.identifier || actionId}">`)
  lines.push(`<title>${action.title}</title>`)
  lines.push(`<status>${action.status_name}</status>`)
  if (action.priority && action.priority !== 'none') {
    lines.push(`<priority>${action.priority}</priority>`)
  }
  if (action.assignee_name) {
    lines.push(`<assignee>${action.assignee_name}</assignee>`)
  }
  if (action.due_at) {
    lines.push(`<due>${new Date(action.due_at).toLocaleDateString()}</due>`)
  }
  if (action.project_name) {
    lines.push(`<project name="${action.project_name}"/>`)
  }
  if (projectRepo?.github_repo) {
    lines.push(`<repository url="https://github.com/${projectRepo.github_repo}">${projectRepo.github_repo}</repository>`)
  }
  if (action.description) {
    lines.push(`<description>${action.description}</description>`)
  }
  if (parentAction) {
    lines.push(`<parent-issue identifier="${parentAction.identifier || action.parent_id}">`)
    lines.push(`<id>${parentAction.id}</id>`)
    lines.push(`<title>${parentAction.title}</title>`)
    if (parentAction.description) {
      lines.push(`<description>${parentAction.description}</description>`)
    }
    lines.push(`</parent-issue>`)
  }
  if (subActions.length > 0) {
    lines.push(`<sub-issues>`)
    for (const sub of subActions) {
      const done = sub.status_category === 'completed'
      lines.push(`<sub-issue identifier="${sub.identifier || ''}" status="${sub.status_name}" completed="${done}">${sub.title}</sub-issue>`)
    }
    lines.push(`</sub-issues>`)
  }
  if (prs.length > 0) {
    lines.push(`<pull-requests>`)
    for (const pr of prs) {
      const status = pr.pr_draft ? 'draft' : pr.pr_state
      lines.push(`<pr repo="${pr.repo_full_name}" number="${pr.pr_number}" state="${status}">${pr.pr_title || 'Untitled'}</pr>`)
    }
    lines.push(`</pull-requests>`)
  }
  if (comments.length > 0) {
    lines.push(`<comments>`)
    // The endpoint returns comments oldest first: the five most recent are the
    // LAST five (kept in reading order).
    const recent = comments.slice(-5)
    for (const comment of recent) {
      const author = comment.author_name || 'Unknown'
      lines.push(`<comment author="${author}">${comment.body || ''}</comment>`)
    }
    lines.push(`</comments>`)
  }
  if (action.links && action.links.length > 0) {
    lines.push(`<links>`)
    for (const link of action.links) {
      lines.push(`<link url="${link.url}">${link.title || link.url}</link>`)
    }
    lines.push(`</links>`)
  }
  lines.push(`</issue>`)

  return { prompt: lines.join('\n') }
}
