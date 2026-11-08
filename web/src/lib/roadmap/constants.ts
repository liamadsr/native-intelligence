// The public roadmap lives in GitHub issues. Every link and API call on the
// roadmap page and docs derives from this one repo name.
export const ROADMAP_REPO = 'liamadsr/native-intelligence'

export const ROADMAP_REPO_URL = `https://github.com/${ROADMAP_REPO}`

/** The roadmap items, as GitHub's issue list filtered by the `roadmap` label. */
export const ROADMAP_ISSUES_URL = `${ROADMAP_REPO_URL}/issues?q=is%3Aissue%20label%3Aroadmap`

/** Community ideas, filtered by the `idea` label. */
export const ROADMAP_IDEAS_URL = `${ROADMAP_REPO_URL}/issues?q=is%3Aissue%20label%3Aidea`

/** Opens the feature request form (`.github/ISSUE_TEMPLATE/feature_request.yml`). */
export const ROADMAP_SUGGEST_URL = `${ROADMAP_REPO_URL}/issues/new?template=feature_request.yml`

/** The same issues as a timeline, in the public GitHub Project. */
export const ROADMAP_PROJECT_URL = 'https://github.com/users/liamadsr/projects/2'

export const ROADMAP_API_URL = `https://api.github.com/repos/${ROADMAP_REPO}/issues?labels=roadmap&state=all&per_page=100`

/** How long Next caches the GitHub response, in seconds. */
export const ROADMAP_REVALIDATE_SECONDS = 300
