# Repository Governance

## Standard Baseline

- Default branch: `main`.
- Branch policy: staged `protect-main` ruleset where GitHub plan support exists.
- Required evidence: PR description, test/verification notes, and release impact.
- Marketplace policy: use GitHub-native features and low-permission Actions first.

## Staged Protection Model

1. Prepare README, contribution, security, issue, PR, and CI files.
2. Run CI on pull requests until status check names are stable.
3. Enable `protect-main` ruleset or branch protection only after required checks are reliable.
4. Keep private repositories documented even when plan limits prevent rulesets.

## Marketplace Resource Policy

Recommended baseline:

- GitHub Actions for project-local checks.
- Dependabot for GitHub Actions and ecosystem updates.
- GitHub CodeQL / security features where the language and plan support it.
- Markdown and artifact hygiene checks implemented as low-permission Actions.

Avoid by default:

- Paid SaaS apps unless there is a clear recurring review burden.
- Apps requiring broad repository write access without a narrow purpose.
- Duplicate review bots on small repositories.

<!-- contributor-policy:start -->
## Contributor Identity Policy

Allowed AI-assisted contributor lines are Codex, Claude, and Gemini. Work
committed by `masuda-so` may be classified under one of those approved lines
when it is prepared through an AI-assisted workflow.

ECC and Jules are excluded from future contributor operations. Do not add new
ECC or Jules bundles, generated notes, co-authored-by trailers, branch names, or
automation metadata. Existing GitHub contributor entries from historical commits
are left intact because this repository does not rewrite published history.

Commit, branch update, and merge operations should start on a five-minute
boundary: `[HH:M0]` or `[HH:M5]`.
<!-- contributor-policy:end -->
