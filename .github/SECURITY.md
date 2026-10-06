# Security Policy

Unfollow Studio runs in the browser console using the user's existing Instagram session. It does not request passwords or send account data to a separate application server.

## Supported Version

Security fixes are provided for the latest version on the default branch. Support is not guaranteed for modified copies or older builds.

## Private Reporting

Do not disclose vulnerability details in public issues or pull request comments.

If private vulnerability reporting is enabled, use **Security → Advisories → Report a vulnerability**. If the button is unavailable, use a private contact channel listed on the repository owner's profile. If no private channel is available, request a secure contact method without disclosing the vulnerability.

Include the affected version, impact, reproduction steps and examples without sensitive data. Do not perform unauthorized actions on real accounts. Do not submit passwords, session cookies, CSRF values or real follower data.

## Security Boundaries

- Live mode runs only on an HTTPS Instagram page. Requests are restricted to specific Instagram paths and GET/POST methods; redirects are not followed.
- The session is checked for each operation. Incomplete or stale scans, protected accounts and queues without user confirmation cannot trigger live actions.
- Unfollow requests with uncertain outcomes are not automatically retried.
- IndexedDB and localStorage records are not encrypted. Other scripts on the same origin can read them. Shadow DOM is not a security boundary.
- Downloaded CSV/JSON files may contain personal connection data. Do not commit these files to a public repository.
- Instagram's internal endpoints can change. Request delays do not guarantee protection from account restrictions.

See the [security review](../docs/SECURITY_REVIEW.md) for the review scope, findings and limitations.
