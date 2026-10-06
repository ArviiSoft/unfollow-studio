# Contributing to Unfollow Studio

Submit bug reports and suggestions through this repository's Issues section. Check existing reports first. For security vulnerabilities, follow the [security policy](SECURITY.md).

## Development

1. Fork the repository, clone your fork and create a branch for your changes.
2. Install Node.js 22.13 or later.
3. Install development dependencies and run the checks:

```sh
npm ci --ignore-scripts
npm run lint
npm run build
npm run build:check
npm audit
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks the PowerShell wrapper. The application and build use no third-party runtime dependencies; development packages are used for linting.

`npm start` serves the demo only at `127.0.0.1:4173`. You can also open `demo.html` directly. The demo uses sample accounts and does not require a personal Instagram session.

## Contribution Guidelines

- After changing source files, regenerate `dist/instagram-unfollow.js`, `dist/instagram-unfollow.txt` and `demo.html`, and include them in your changes.
- Preserve account verification, protected accounts, explicit confirmation and the restriction on actions after incomplete scans.
- Do not automatically retry POST requests after failures.
- For security or behavior changes, describe the review scope and validation steps in the pull request.
- Keep explanations in documentation rather than adding comments to source files.
- Do not share passwords, cookies, CSRF values, HAR files, real follower lists or personal exports.
- Describe the problem, resulting behavior and checks performed in your pull request.

## Automation

The quality workflow runs lint, bundle consistency checks and dependency auditing on Node.js 22 and 24. It has read-only repository access, and checkout credentials are not persisted.

Dependabot checks npm dependencies and GitHub Actions weekly. Actions are pinned to full commit IDs.

The stale workflow runs daily at 03:17 UTC. It applies the `stale` label after 14 days of inactivity and closes the item after another 7 days. Issues and pull requests labeled `security` or `pinned`, issues labeled `bug`, and draft pull requests are exempt. Repository maintainers should apply exemption labels when appropriate.
