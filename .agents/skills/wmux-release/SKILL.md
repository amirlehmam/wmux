---
name: wmux-release
description: How a wmux release is cut and shipped - the version bump and tag, the CI workflow (.github/workflows/release.yml) that tests, packages, optionally signs and publishes it, the release notes and the Scoop bucket. Use when releasing or bumping the version, writing release notes, when a release run fails, when editing bucket/wmux.json, release.yml or electron-builder.json, when adding anything that must ship outside the asar (resources/, a new src/cli/ module, a process.resourcesPath lookup), or when checking whether a fix is in a release.
---

# Releasing wmux

CI builds and publishes every release. Pushing a `v<version>` tag runs `.github/workflows/release.yml` on `windows-latest`, which publishes three assets to a GitHub release:

- `wmux-<version>-setup.exe`, the NSIS installer
- `wmux-<version>-win-x64.zip`, the portable zip
- `latest.yml`, which installed copies read to auto-update through the installer

Don't build or upload a release by hand. Only this workflow produces the installer that `latest.yml` points at.

Run the commands below in Git Bash (`rm -rf`, `VAR=1 cmd` and `$(mktemp -d)` fail in PowerShell), in the checkout that has `master`, where `origin` is amirlehmam/wmux. The `gh` commands pass `--repo amirlehmam/wmux` because a checkout may also have a fork remote.

## Cut a release

1. Merge everything that should ship, then update `master`. Every release leaves a bot commit there (the Scoop manifest), so pull first:

   ```bash
   git pull --ff-only origin master
   ```

2. Run what the CI gates run, in CI's order, so the tag doesn't fail. CI installs with `npm ci` on Node 20 and runs the tests with no `dist/`:

   ```bash
   npm ci
   rm -rf dist && npm test
   npm run build:main && npm run verify:resources
   npx vite build && WMUX_REQUIRE_BUILD=1 npx vitest run tests/unit/remote-ui-build.test.ts
   ```

   `verify:resources` fails when a checked-in copy under `resources/` has drifted from its source. Regenerate both copies, check again, and commit them before tagging. Don't rely on the copy commands it prints: they cover only two of the CLI files and never remove a copy whose source was deleted.

   ```bash
   rm -rf resources/shell-integration && cp -r src/shell-integration resources/shell-integration
   rm -f resources/cli/*.js && cp dist/cli/*.js resources/cli/
   npm run verify:resources
   ```

3. Bump, commit, push, then tag the bump commit. The workflow names its files after the `package.json` version and never checks it against the tag. A tag without the bump publishes the old version number, and the Scoop step then points the bucket at the previous release's zip with the new build's hash, which breaks `scoop install`.

   ```bash
   npm version <version> --no-git-tag-version
   node -p "require('./package.json').version"   # must print <version>
   git add package.json package-lock.json
   git commit -m "chore(release): bump to <version>"
   git push origin master
   git tag -a v<version> -m "wmux <version>"
   git push origin v<version>
   ```

4. Watch the run. A tag run reports the tag as its branch. It can take a few seconds to be listed and about six minutes to finish, so run the watch in the background or with a long timeout:

   ```bash
   gh run list --repo amirlehmam/wmux --workflow release.yml --branch v<version> --limit 1
   gh run watch <id> --repo amirlehmam/wmux --exit-status
   ```

## After it publishes

- **Write the release notes.** The workflow publishes GitHub's generated notes. Replace them with a written summary in the shape of the previous release's (`gh release view v<previous> --repo amirlehmam/wmux --json body --jq .body`), drawn from `git log --oneline v<previous>..v<version>`. Publish it with `gh release edit v<version> --repo amirlehmam/wmux --notes-file <file>`. These notes are what the in-app changelog shows (`src/main/changelog.ts`).
- **Check the Scoop commit.** `chore(scoop): bucket manifest for <version>` should land on `master` from `github-actions[bot]`. Pull it before your next commit.
- **Compare asset sizes with the previous release:** `gh release view v<previous> --repo amirlehmam/wmux --json assets --jq '.assets[] | "\(.name) \(.size)"'`. A jump that no change explains means something new is being packaged.
- **winget is not updated.** `.github/workflows/winget.yml` triggers on a published release, but a release created with the workflow's `GITHUB_TOKEN` starts no other workflow, and even when it did run, its only step was skipped. Don't dispatch it or try to fix it as part of a release.

## What the workflow checks

In order. Each of these fails the run before anything is published:

| Step | Fails when |
|---|---|
| `npm test` | Any unit test fails, including the renderer typecheck (`tests/unit/renderer-typecheck.test.ts`) and `tests/unit/packaging.test.ts`, which is where a missing `extraResources` entry shows up. |
| `npm run build:main` | `tsc` fails for main, preload, shared or the CLI. |
| `npm run verify:resources` | A `resources/` copy differs from its source. |
| `npx vite build` | The renderer build fails. |
| Remote Console build output | `remote-manifest.json`, `remote/index.html` or `remote-console/runtime.js` is missing, or `remote-ui-build.test.ts` fails with `WMUX_REQUIRE_BUILD=1` (the phone page, its asset references and its manifest closure). The console fails silently at runtime without these (#254). |
| `electron-builder --win --publish never` | Packaging fails. |
| Remote Console files in the packaged asar | The same three files are missing from `release/win-unpacked/resources/app.asar`. |

Nothing checks the tag against `package.json`, the node-pty prebuilds, or the files beside the asar; see "Check that a fix shipped".

SignPath signs only the installer, never the zip's `wmux.exe`, and only when its secrets are set. Whether a given release is signed is in its run's annotations (`gh run view <id> --repo amirlehmam/wmux`):

- `SignPath submission failed (HTTP <code>)` means the installer shipped unsigned. The `Process completed with exit code 1` annotation beside it in a green run comes from that `continue-on-error` step and is not a failure; the step list reports that step as `success`, so it can't tell you this.
- `Installer signature is not chain-trusted` means it was signed with an untrusted (self-signed) certificate and shipped anyway.

A submission that is accepted and then denied, fails, is cancelled or takes more than 10 minutes fails the run before anything is published.

The comments in `release.yml` explain why each step is shaped the way it is; read them before changing one. Two rules there look removable and are not:

- `latest.yml` points at `setup.exe`, never the zip. electron-updater's NSIS updater can download a zip but cannot install it, so clients loop on "update ready" (#96).
- `latest.yml` is generated after signing, because SignPath rewrites the installer and an earlier hash would not match.

## When a release run fails

A run that fails before the "Create or update GitHub Release" step publishes nothing. Confirm that first: `gh release view v<version> --repo amirlehmam/wmux` should report "release not found".

- **The failure isn't in the code** (network, runner): re-run it with `gh run rerun <id> --repo amirlehmam/wmux --failed`. A re-run builds the commit the tag pointed at when it was first pushed and is still a `push` event, so it publishes and updates the Scoop bucket like the original. Never re-run an older run: after a tag move it would publish the old commit, and for an earlier version it re-uploads that version and moves `bucket/wmux.json` back to it.
- **Move the tag to the fix commit,** as 2.38.0, 2.40.0 and 2.42.0 did. Only do this when nothing was published, because a published release's assets, `latest.yml` and Scoop manifest would describe the old commit. If the old run is still going, cancel it and wait until it shows as cancelled: the workflow has no concurrency limit, so both runs would publish into the same release.

  ```bash
  gh run cancel <id> --repo amirlehmam/wmux
  git pull --ff-only origin master
  node -p "require('./package.json').version"   # must print <version>
  git tag -d v<version> && git push origin :refs/tags/v<version>
  git tag -a v<version> -m "wmux <version>" && git push origin v<version>
  ```

  Other clones keep the old tag until they run `git fetch origin --tags --force`.

- **Or release the next patch version,** as 2.43.1 did for 2.43.0, and say in its notes that the previous version was tagged but never released.

Don't use `workflow_dispatch` to rebuild a release. The run checks out the branch it was dispatched on (`master` by default); the `tag` input only names the release it uploads into. Any dispatched run publishes, re-uploading the assets with new hashes and skipping the Scoop step, so `bucket/wmux.json` stops matching the zip.

The Scoop step is `continue-on-error`, so when it fails the run still ends green and the bucket stays behind. GitHub cannot re-run a single step, and re-running the job rebuilds and re-uploads everything. Update the bucket by hand from the published zip instead:

```bash
git pull --ff-only origin master
git log -1 --format=%s -- bucket/wmux.json   # stop here if this already names <version>
D=$(mktemp -d)
gh release download v<version> --repo amirlehmam/wmux --pattern '*-win-x64.zip' --dir "$D"
node scripts/update-scoop-manifest.mjs <version> "$D/wmux-<version>-win-x64.zip"
git add bucket/wmux.json
git commit -m "chore(scoop): bucket manifest for <version>"
git push origin master
```

## Packaging changes

`electron-builder.json` decides what ships: `files` for the asar, `asarUnpack` for node-pty's native prebuilds, and `extraResources` for everything that has to live outside the asar.

- A runtime resource that `src/main/` resolves through `process.resourcesPath` needs an `extraResources` entry. `packaging.test.ts` finds these only as a string literal right after `process.resourcesPath` (`path.join(process.resourcesPath, '<name>', …)`) in a top-level `src/main/*.ts` file, and compares only the first path segment. A computed path, or a lookup in a subdirectory, escapes the test; `codex-bin` and `codex-bin-ps` are already computed in `codex-launcher.ts`. Check those in a packaged build.
- The CLI ships file by file under `resources/cli/`, outside the asar. Every `src/cli/` file that runs in an install needs its own `dist/cli/<name>.js` entry: one that a shipped CLI file imports, and one that main launches by path (as `pty-manager.ts` launches `wmux-codex.js`). `packaging.test.ts` catches only the imports, and since `cli` is already packaged, a missing `cli/<name>.js` lookup passes. It follows only `./` sibling imports, so keep CLI imports that way: a `../shared/…` import would ship a CLI that fails with `MODULE_NOT_FOUND`. An npm package the CLI imports needs a `node_modules/<pkg>` → `cli/node_modules/<pkg>` entry (as `ws` has), and the test sees only single-line imports.
- `src/shell-integration/` ships whole through `extraResources`, so every file added there reaches users.
- To try a packaging change before tagging, build it locally. Never dispatch `release.yml` to test, since every run publishes. On a checkout path without spaces (node-gyp and electron-builder's winCodeSign both break on one), run `rm -rf dist release && npm run build:main && npx vite build && npx electron-builder --win --dir --publish never`. Then inspect `release/win-unpacked/resources/` and `npx asar list release/win-unpacked/resources/app.asar`. `--dir` skips the installer, so a change to the `nsis` block or `build/installer.nsh` needs the same command without `--dir`.

## Check that a fix shipped

CI builds exactly the tagged commit, so check the source first:

```bash
git fetch origin --tags --force && git merge-base --is-ancestor <commit> v<version> && echo in-tag
```

`--force` matters because some tags were moved after a failed run, and a plain fetch keeps an old local tag. Download the release only to check what the build and packaging produced. Run this from the repo root, where `npx asar` resolves to the installed copy:

```bash
D=$(mktemp -d)
gh release download v<version> --repo amirlehmam/wmux --pattern '*-win-x64.zip' --dir "$D"
unzip -q "$D"/wmux-<version>-win-x64.zip -d "$D/unpacked"
npx asar extract "$D/unpacked/resources/app.asar" "$D/app"
grep -rl '<marker>' "$D/app/dist/main" "$D/app/dist/preload" "$D/app/dist/shared" "$D/app/dist/renderer/assets" || echo MISSING
grep -rl --exclude=app.asar '<marker>' "$D/unpacked/resources" || echo MISSING
ls "$D/unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/" "$D/unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/"
```

- `tsc` compiles main file by file, so a fix in `pty-manager.ts` is in `dist/main/pty-manager.js`, not `index.js`.
- Grep every renderer chunk, not only `index-*.js`. Code that both the desktop and the phone entries import (React, xterm, `src/shared/*`) lands in a shared chunk (#254).
- Files mapped by `extraResources` (the CLI, shell integration, the agent plugins) sit beside the asar in `$D/unpacked/resources/`; the second grep covers them.
- The prebuilds folder should hold `conpty.node`, `conpty_console_list.node`, `pty.node` and a `conpty/` folder with `conpty.dll` and `OpenConsole.exe`. Without `conpty/`, every spawn falls back to the inbox ConPTY (see `pty-manager.ts`), which garbles fast TUI repaints.
