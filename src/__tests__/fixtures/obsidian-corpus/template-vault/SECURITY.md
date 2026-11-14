# Security Policy

## Supported Scope

Security review covers the current `main` branch of `Template-Vault` and any actively maintained release assets documented in the README.

## Reporting

Do not open a public issue for secrets, private keys, personal data exposure, or exploitable vulnerabilities. Use a private contact channel with the repository owner and include:

- A concise description of the issue.
- Affected files, commits, URLs, or deployment targets.
- Reproduction steps or proof of impact.
- Whether any credential or user data may have been exposed.

## Secrets And Sensitive Data

- Never commit API keys, App Store credentials, deployment tokens, `.env` files, local databases, or machine-specific editor state.
- Rotate credentials immediately if they are exposed.
- Prefer GitHub Dependabot, secret scanning, and low-permission Actions over broad third-party access.

## Disclosure

Public disclosure should wait until the issue is understood, mitigated, and any affected credentials or deployments have been rotated.
