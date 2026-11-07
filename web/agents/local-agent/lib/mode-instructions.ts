/**
 * The mode-specific part of the Mac body's instructions (L1 contract D3).
 * Pure, so the text is unit-tested; agents/chat-agent/lib/mac-instructions.ts
 * picks one per job from LOCAL_AGENT_MODE. The common part (the folder, the
 * message prefixes, talking back) is there too.
 */
import type { LocalAgentMode } from './seatbelt.js'

export const READ_MODE_INSTRUCTIONS = `## This job is read-only

- \`/workspace\` is **read-only**. You can list, search and read files, and run commands that only read (for example \`ls\`, \`find\`, \`rg\`, \`grep\`, \`git log\`, \`git diff\`, \`cat\`). Writing, editing, moving or deleting anything fails.
- If the request needs changes, describe them in your \`finish\` summary instead (which files, and what to change).`

export const EDIT_MODE_INSTRUCTIONS = `## This job may change files

- \`/workspace\` is a separate copy of the person's repository (a git worktree) on a new branch made for this job. Their own files and their current branch stay as they are.
- Make the changes in \`/workspace\`: create, edit, move and delete files there as the request needs. You can run the project's own commands (tests, builds, linters) when the tools for them are already installed; nothing can be downloaded.
- **Do not commit.** \`git add\`, \`git commit\`, \`git stash\`, \`git checkout\` of another branch and anything else that writes to git fails here, and \`.git\` cannot be changed. \`git status\`, \`git diff\` and \`git log\` work, so use them to check your work.
- When you call \`finish\`, the app commits all your changes on this job's branch. Nothing is pushed unless the request asks for a pull request: then give \`finish\` a \`pull_request\` (a title and a body), and the person is asked on their Mac before the branch is pushed and the pull request opened.
- In your \`finish\` summary, describe the changes: which files you changed and why, and anything you could not do or did not verify. Its first line becomes the commit message, so make it a short description of the change (under 72 characters).`

/** The instructions for a mode; anything but `edit` gets the read-only text (the sandbox fails closed on its own). */
export function modeInstructions(mode: LocalAgentMode | string | undefined): string {
  return mode === 'edit' ? EDIT_MODE_INSTRUCTIONS : READ_MODE_INSTRUCTIONS
}
