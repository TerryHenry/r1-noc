# Security policy

R1 NOC Wall holds API credentials for RUCKUS One and can restart itself from an uploaded release file, so please report security problems privately.

- **Report** a suspected vulnerability with GitHub's **"Report a vulnerability"** (Security tab → *Advisories*) rather than a public issue.
- Include the version (editor → *Software update*, or `package.json`), how it is installed (appliance, Mac, Windows, source) and steps to reproduce. Please do not include real API keys, tokens or customer data.
- Fixes ship in a new release; the [changelog](CHANGELOG.md) notes security fixes.

**Hardening notes:** use a *read-only* RUCKUS One API key; turn on HTTPS and an editor login (or admin key) before exposing the editor; keep `data/` and `.env` private (they hold secrets and are git-ignored); install release files only from a source you trust.
