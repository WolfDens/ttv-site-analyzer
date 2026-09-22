GitHub Actions workflows for this repo.

**Currently none.** `codex-review.yml` (a per-push Codex review) was removed on 2026-09-22:
it required an `OPENAI_API_KEY` repo secret that was never added, so it failed on every run
from August onward and showed a permanently red check on each PR.

Code review is handled by the **Codex cloud integration**, which reviews every pull request
and is working — it caught two P1 defects on PR #17. Trigger a re-review by commenting
`@codex review` on a PR.

If you ever want per-push reviews back, restore the workflow from git history
(`git log --diff-filter=D -- .github/workflows/codex-review.yml`) and add the secret first:
Repo → Settings → Secrets and variables → Actions → New repository secret → `OPENAI_API_KEY`.
