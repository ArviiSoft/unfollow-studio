# Changelog

All notable changes to Unfollow Studio are documented in this file, with the newest version first.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project follows [Semantic Versioning](https://semver.org/).

- **Added:** New features and project resources.
- **Changed:** Updates to existing behavior, configuration and documentation.
- **Removed:** Features, files or dependencies removed from the project.
- **Fixed:** Bug fixes.
- **Security:** Security fixes and hardening.

## [v1.1.3] - 2026-10-06

### Added

- Added Git ignore rules for environment files, private keys, backups and personal Instagram CSV/JSON exports.
- Added line-ending rules for consistent source files and generated output across operating systems.

### Fixed

- Fixed malformed HTTP request targets terminating the local demo server; invalid targets now return HTTP 400.
- Fixed REST pagination accepting a terminal flag together with a continuation cursor.
- Fixed non-boolean pagination flags being accepted as valid completion metadata.
- Fixed missing lint commands and dependency installation metadata in the copied CI configuration.
- Normalized source line endings during bundling to produce consistent output on Windows and Unix systems.

### Security

- Restricted authenticated requests to an allowlist of relative Instagram paths and GET/POST methods before sending the CSRF header.
- Restricted the demo server's Host header to localhost or 127.0.0.1 and rejected absolute or protocol-relative request targets.
- Added Content Security Policy, frame protection, content-type protection and referrer policy headers to the demo server.

## [v1.1.2] - 2026-10-06

This version removes the preliminary profile lookup that prevented some scans from starting and adds bounded recovery from temporary list rate limits.

### Added

- Added up to three retries for follower and following list GET requests that return HTTP 429.
- Added retry delays of 30, 60 and 90 seconds, respecting a longer server-provided `Retry-After` deadline.
- Added an on-screen cooldown countdown showing the affected list and retry attempt.
- Added cancellation of the cooldown through the **Stop** button.

### Changed

- Changed scans to start directly at `/api/v1/friendships/<signed-in-id>/following/`, then retrieve all pages of the same account's followers.
- Used the signed-in account ID to identify the scan target instead of relying on a username lookup.
- Obtained the displayed username from structured page data matching the session account ID or a validated saved snapshot, with **Your account** as the fallback.
- Determined list completeness from pagination signals and cursor validation without a separate profile-count request.
- Allowed one read-only GraphQL pass after a pagination anomaly, with validation of its reported count.
- Retried the same URL and cursor after list rate limits without switching endpoints.
- Kept unfollowing disabled after incomplete scans or exhausted retries.

### Removed

- Removed the remaining profile lookup dependency, including `web_profile_info`, from the scan flow.
- Removed the username prompt previously used before scanning.
- Removed reliance on a separate profile response to begin retrieving the signed-in account's lists.

### Fixed

- Fixed scans failing before list retrieval when Instagram rejected or rate-limited the preliminary profile lookup.
- Fixed temporary HTTP 429 responses immediately ending a list scan by allowing a bounded retry of the affected page.
- Made rate-limit waiting visible and cancellable before list retrieval resumes.

### Request Behavior

- Pagination requests remain 2.5 seconds apart, with a 10-second break after every 15 pages when more pages remain.
- Authentication failures, verification challenges, network errors, relationship checks and unfollow POSTs are not automatically retried.
- A rate limit never triggers an alternate endpoint.
- These changes do not bypass Instagram restrictions or guarantee that live list endpoints will accept a scan.

[v1.1.3]: https://github.com/ArviiSoft/unfollow-studio/releases/tag/v1.1.3
[v1.1.2]: https://github.com/ArviiSoft/unfollow-studio/releases/tag/v1.1.2