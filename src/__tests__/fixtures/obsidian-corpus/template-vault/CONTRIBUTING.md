# Contributing

Thank you for helping maintain `Template-Vault`.

## Working Model

- Use short-lived branches and pull requests for reviewed changes.
- Keep each pull request focused on one behavior, documentation area, or release task.
- Include verification notes: commands run, environments used, and known gaps.
- Preserve repository-specific release and privacy requirements.

## Commit And History Hygiene

- Keep commit messages concise and descriptive.
- Do not commit secrets, local machine paths, generated caches, binary databases, or editor state.
- If history must be rewritten, coordinate the timing and use `--force-with-lease`.

## Review Checklist

- README and support links still point to valid files.
- CI or local checks relevant to the change have been run.
- Product, security, and release notes are updated when behavior changes.
- Marketplace or third-party integrations are documented before they are enabled.

## Repository Visibility

This is a public repository. Avoid exposing private roadmap details, credentials, or unpublished App Store / deployment material.

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
