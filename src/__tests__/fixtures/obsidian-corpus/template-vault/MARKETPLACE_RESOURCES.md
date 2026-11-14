# Marketplace And Automation Resources

This repository follows a low-permission, free-first automation policy.

## Approved Baseline

- `actions/checkout`: checkout source for repository-local checks.
- Dependabot: keep GitHub Actions and project dependencies current.
- GitHub security features: secret scanning, Dependabot alerts, and CodeQL where applicable.
- Repository-local shell/Python/Swift checks before third-party SaaS apps.

## Candidate By Repository Type

- Swift/iOS: Xcode or SwiftPM checks on GitHub-hosted macOS runners when cost and runtime are acceptable.
- Python/Django: `uv`, pytest, pre-commit, and dependency review.
- Vault/docs/static pages: Markdown structure checks, link checks, banned artifact scans, and Pages deployment checks.

## Deferred

The following are not enabled by default because they may require payment, broad permissions, or an external account:

- CodeRabbit / AI code review apps.
- Codecov / Coveralls coverage SaaS.
- Rewind backups.
- Visual regression services.

Adopt these only after documenting the repository-specific need in this file.
