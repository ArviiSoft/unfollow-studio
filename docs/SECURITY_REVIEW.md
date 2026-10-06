# Pre-publication Security Review

**Date:** October 6, 2026  
**Version:** Unfollow Studio 1.1.3  
**Scope:** Local source files, generated scripts, the demo server, export and storage behavior, npm dependencies and GitHub configuration.

No embedded passwords, private keys or real session values were found in the reviewed files. No confirmed critical or high-severity application vulnerability was identified. This report summarizes a limited security review and does not guarantee that every vulnerability has been found.

## Findings and Fixes

| Finding | Impact / assessment | Resolution |
| --- | --- | --- |
| URL parsing errors in the demo server were not caught | Low: a malformed HTTP request target sent to the loopback server could terminate the local development process. The production console script was not affected. | Invalid, absolute and protocol-relative targets are rejected with HTTP 400. The server continues handling subsequent requests. |
| REST lists could be marked complete when a continuation cursor conflicted with a terminal flag | Data integrity: an incomplete follower list could produce incorrect classifications. The existing relationship check before each action provided an additional safeguard against an incorrect unfollow. | Conflicting cursors and non-boolean flags are rejected. Actions remain disabled if the alternate read-only pass cannot complete. |
| The general request helper did not validate destinations itself | Defense in depth: existing callers used fixed relative paths. No externally reachable token exfiltration path was confirmed. | Allowed relative paths and GET/POST methods are validated before a request containing a token is sent. |
| The demo server lacked Host validation and browser response policies | Defense in depth: reduce exposure to DNS rebinding and framing. The server was already bound to loopback and used a file allowlist. | Only localhost/127.0.0.1 Host values are accepted. The CSP blocks network connections and framing. |
| CI configuration and documentation had been copied from another project | Missing lint commands and a lockfile prevented checks from running. Actions referenced by mutable tags could change. | Project-specific linting, a lockfile and bundle checks were added. Actions were pinned to full commit IDs, and checkout credential persistence was disabled. |
| Git ignore rules covered only node_modules and logs | Common sensitive files and personal account exports could be committed accidentally. | Environment files, private keys and personal CSV/JSON exports are excluded. Ignore rules alone do not guarantee that data cannot leak. |

## Verified Safeguards

- Account ID and username validation, including rejection of snapshots and protection backups belonging to another account.
- CSV cell escaping and neutralization of content that could start spreadsheet formulas.
- Session verification before and after requests.
- No POST requests for protected accounts, accounts that now follow the user or accounts that are no longer eligible.
- Queue termination after an uncertain POST result, without automatic retries.
- Bounded HTTP 429 retries, with no retry or alternate endpoint attempt after verification responses.
- Continued demo server operation after malformed HTTP targets, with source and environment files excluded from served content.
- Safe rendering of external data, explicit confirmation, and action blocking after account changes or incomplete scans.

## Development Checks

The following results were recorded during the review on Windows with Node.js 22.20.0:

| Check | Result |
| --- | --- |
| `npm run lint` | No errors or warnings |
| `npm run build` and `npm run build:check` | Successful; all three generated files matched the source |
| `npm audit --json` | No known vulnerabilities; all third-party packages were development dependencies |
| JavaScript parser comment check | No comments in source or generated scripts; CSS and HTML comments were also checked |
| Secret pattern scan and source review | No known key/token pattern matches or real session values found |
| Documentation and screenshots | 17 local links were valid at the time of the review; all four screenshots matched their originals by SHA-256 |

No real Instagram account was accessed. The GitHub-hosted Linux/Node.js 24 workflow had not been run in a remote repository. Lint and bundle consistency checks do not verify behavior on a live account.

## Remaining Limitations and Publication Notes

1. **Same-origin code:** The application runs on an Instagram page. localStorage and IndexedDB are not encrypted; same-origin scripts and extensions with sufficient permissions can access the data. Shadow DOM isolation is not a security boundary.
2. **Platform behavior:** Future behavior of Instagram's internal endpoints and freedom from account restrictions cannot be guaranteed. A relationship may change in the short interval between a check and an action.
3. **Screenshots:** The four user-provided screenshots were included without modification. The first shows an account name and connection counts; the lists include some initials or name fragments. These become public when the README is published.
4. **Git history:** The folder was not a Git repository at the time of the review. Previous commits, remote repository settings, branch protection, Actions runs and GitHub secret scanning results could not be inspected.
5. **Private vulnerability reporting:** Enable private vulnerability reporting on GitHub after creating the repository. A local SECURITY.md file does not enable the feature.
6. **License:** No license file was present at the time of the review. Making the repository public does not replace choosing a license that grants reuse rights. The license choice belongs to the project owner.

The approach to pinned Actions and least privilege follows [GitHub's secure use reference](https://docs.github.com/en/actions/reference/security/secure-use). See [GitHub's private vulnerability reporting documentation](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository) for the reporting setting.
