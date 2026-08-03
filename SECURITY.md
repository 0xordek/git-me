# Security Policy

## Supported Versions

Security fixes target the latest `0.5.x` release and `main`.

## Reporting a Vulnerability

Please report vulnerabilities privately using GitHub Security Advisories for this repository.

Do not open a public issue for security-sensitive reports.

Include:

- affected version or commit
- deployment environment
- reproduction steps
- expected impact
- any suggested mitigation

Do not include passwords, bearer tokens, R2 credentials, or object contents in reports.

Versions `0.4.0` and `0.4.1` may fail to retain a generated admin secret in macOS Keychain. Rotate the Worker secret and follow the recovery procedure in `README.md`; do not reuse or disclose the old value.

Versions `0.3.0` through `0.5.0` derive password records with 600,000 PBKDF2 iterations, above the 100,000 the Workers runtime accepts, so user creation fails with HTTP 500 on Cloudflare. Upgrade to `0.5.1`, redeploy the Worker, and create the users again. `0.5.1` lowers the cost to the runtime limit and stores the iteration count with each record, so records written at 600,000 by a runtime without the limit keep verifying.

Maintainers will acknowledge valid reports as soon as possible and coordinate a fix before public disclosure.
