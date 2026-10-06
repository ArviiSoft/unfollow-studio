# Unfollow Studio Support Guide

See the [README](../README.md) for usage instructions, screenshots, the demo and development commands.

## Reporting Bugs

Use this repository's Issues section. Include the application version, browser version, reproduction steps, expected behavior and the error message shown in the panel. Redact usernames and personal information from screenshots. Do not attach cookies, session tokens, HAR files or follower exports.

## Common Issues

- **HTTP 429:** Instagram has rate-limited the request. Follow the panel's cooldown and avoid repeatedly starting new scans.
- **Verification or sign-in error:** Stop the queue and check the notice on Instagram. Reopen the panel after switching accounts.
- **Incomplete scan:** Unfollowing remains disabled until both lists have finished loading.
- **Older panel:** Stop the operation, refresh the Instagram tab and run the current build again.
- **Demo:** It uses sample accounts and does not perform actions on a real Instagram account.
- **Development:** Follow the setup and validation commands in the [contribution guide](CONTRIBUTING.md).

You can also submit feature requests through Issues. For security vulnerabilities, follow [SECURITY.md](SECURITY.md).
