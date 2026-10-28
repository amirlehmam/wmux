---
name: wmux-release
description: How a wmux release is cut and shipped - the version bump, the tag, and the CI workflow (.github/workflows/release.yml) that tests, packages, signs and publishes it. Use when releasing a version, when a release run fails, when changing release.yml or electron-builder.json packaging, or when checking that a fix made it into a release.
---

# Releasing wmux

CI builds and publishes every release. Pushing a `v<version>` tag runs `.github/workflows/release.yml` on `windows-latest`, which publishes three assets to a GitHub release:

- `wmux-<version>-setup.exe`, the NSIS installer
- `wmux-<version>-win-x64.zip`, the portable zip
- `latest.yml`, which installed copies read to auto-update through the installer

Don't build or upload a release by hand. Only this workflow produces the installer that `latest.yml` points at.

## Cut a release

1. Merge everything that should ship to `master`, then check what the CI gates will check, so the tag doesn't fail:

   ```bash
   npm test
   npm run build:main && npm run verify:resources
   ```

   `verify:resources` fails when a checked-in copy under `resources/` has drifted from its source (`src/shell-integration/`, or the `dist/cli/*.js` build output). It prints the copy commands; commit the regenerated files first.

2. Bump the version in `package.json` and `package-lock.json`, commit, push, then tag:

   ```bash
   npm version <version> --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "chore(release): bump to <version>"
   git push origin master
   git tag -a v<version> -m "wmux <version>"
   git push origin v<version>
   ```

3. Watch the run: `gh run list --workflow release.yml --limit 1` gives its id, and `gh run watch <id>` follows it. The release notes are GitHub's generated notes.

After the release is published, the workflow commits `bucket/wmux.json` to `master` as `github-actions[bot]` (the repo is its own Scoop bucket), and `.github/workflows/winget.yml` opens a winget-pkgs PR when the `WINGET_TOKEN` secret is set. Pull before the next commit to `master`.

## What the workflow checks

In order, and each one fails the release before anything is published:

| Step | Fails when |
|---|---|
| `npm test` | Any unit test fails. `tests/unit/packaging.test.ts` is where a missing `extraResources` entry shows up. |
| `npm run verify:resources` | A `resources/` copy differs from its source. |
| Remote Console build output | `remote-manifest.json`, `remote/index.html` or `remote-console/runtime.js` is missing. The console fails silently at runtime without them (#254). |
| `electron-builder --win --publish never` | Packaging fails. |
| Remote Console files in the packaged asar | The same three files are missing from `release/win-unpacked/resources/app.asar`. |

SignPath signing runs only when its secrets are set, and a rejected submission ships unsigned rather than failing. The comments in `release.yml` explain why each step is shaped the way it is; read them before changing one. Two rules there look removable and are not:

- `latest.yml` points at `setup.exe`, never the zip. electron-updater's NSIS updater can download a zip but cannot install it, so clients loop on "update ready" (#96).
- `latest.yml` is generated after signing, because SignPath rewrites the installer and an earlier hash would not match.

## When a release run fails

A run that fails before the "Create or update GitHub Release" step publishes nothing. Fix the problem on `master` and release the next patch version; 2.43.0 failed its tests in CI and 2.43.1 shipped the fix.

- The Scoop step is `continue-on-error`, so a push race there leaves the release published and the bucket behind. Re-run the step, or run `node scripts/update-scoop-manifest.mjs <version> <path-to-zip>` and commit `bucket/wmux.json`.
- `workflow_dispatch` with a `tag` input rebuilds an existing tag. It skips the Scoop step, so an older tag never moves the bucket backwards.

## Packaging changes

`electron-builder.json` decides what ships: `files` for the asar, `asarUnpack` for node-pty's native prebuilds, and `extraResources` for everything that has to live outside the asar.

- A runtime resource that `src/main/` resolves through `process.resourcesPath` needs an `extraResources` entry. `packaging.test.ts` derives the expected list from the source and fails without it.
- The CLI ships file by file under `resources/cli/`, outside the asar. A new `src/cli/` module that a shipped CLI file imports needs its own entry, and so does an npm package the CLI imports (as `node_modules/ws` is). `packaging.test.ts` checks both.
- `src/shell-integration/` ships whole through `extraResources`, so every file added there reaches users.

## Check that a fix shipped

Download the release and look inside the asar. Run this from the repo root, where `npx asar` resolves to the installed copy:

```bash
D=$(mktemp -d)
gh release download v<version> --repo amirlehmam/wmux --pattern '*-win-x64.zip' --dir "$D"
unzip -q "$D"/wmux-<version>-win-x64.zip -d "$D/unpacked"
npx asar extract "$D/unpacked/resources/app.asar" "$D/app"
grep -l '<marker>' "$D"/app/dist/renderer/assets/*.js || echo MISSING
grep -c '<marker>' "$D/app/dist/main/index.js"
ls "$D/unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/"
```

Grep every renderer chunk, not only `index-*.js`. Code that both the desktop and the phone entries import (React, xterm, `src/shared/*`) lands in a shared chunk (#254). The last command should list `conpty.node` and `pty.node`. Files mapped by `extraResources`, such as `resources/cli/` and `resources/shell-integration/`, sit beside the asar in `$D/unpacked/resources/`, not inside it.
