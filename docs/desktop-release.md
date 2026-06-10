# Releasing the iClaw macOS desktop app

How a signed, notarized `.dmg` gets built, published, and auto-updated. macOS
(Apple Silicon) only for now.

## The mental model

Two things, two jobs:

- **GitHub Releases** — hosts the artifacts (`iClaw-arm64.dmg`, `iClaw-arm64.zip`,
  `latest-mac.yml`). It is BOTH where users download from AND the update feed the
  installed app polls.
- **The website (landing page)** — just a "Download for Mac" button linking to the
  `.dmg` on GitHub Releases. It stores nothing itself.

```
build notarized → publish to GitHub Releases → website button links to it
                                              → installed apps auto-update from it
```

The GitHub repo (or at least its Releases) must be **public**, or neither the
website download nor auto-update works without a login.

## One-time setup (already done — for reference)

1. **Apple Developer Program** ($99/yr) and accept the latest **Program License
   Agreement** at developer.apple.com/account (Account Holder only — otherwise
   cert creation fails with "PLA Update available").
2. **Developer ID Application** certificate (Xcode → Settings → Accounts → Manage
   Certificates → + → Developer ID Application). NOT "Apple Distribution" (that's
   App Store only). Valid ~5 years.
3. **Passwordless notarization** — store an app-specific password (appleid.apple.com)
   in the Keychain once:
   ```sh
   xcrun notarytool store-credentials "iclaw-notarize" \
     --apple-id "<apple-id-email>" --team-id "<TEAMID>" --password "<app-specific-pw>"
   ```
4. **`.env.release`** — copy `.env.release.example` → `.env.release` (gitignored)
   and fill in `CSC_NAME` + `APPLE_TEAM_ID` (the password is NOT here — it's in the
   Keychain). Find your identity with `security find-identity -v -p codesigning`.
   `CSC_NAME` must omit the `Developer ID Application:` prefix.

## Cutting a release

1. **Bump the version** in `package.json` (e.g. `0.4.0` → `0.4.1`). Auto-update only
   triggers on a higher version.
2. Build locally (no upload):
   ```sh
   npm run release
   ```
   Or build **and** publish to GitHub Releases (needs `GH_TOKEN` with `repo` scope
   in `.env.release`):
   ```sh
   npm run release:publish
   ```
   This signs with Developer ID, notarizes via the Keychain profile (no password
   prompt), staples the ticket, and emits `release/iClaw-arm64.dmg` + `.zip` +
   `latest-mac.yml`. Notarization waits on Apple's queue (~3–15 min).
3. Verify the result:
   ```sh
   spctl -a -vvv -t install release/mac-arm64/iClaw.app   # → accepted, Notarized Developer ID
   xcrun stapler validate release/mac-arm64/iClaw.app
   ```
4. If you used `npm run release` (no publish), upload `iClaw-arm64.dmg`,
   `iClaw-arm64.zip`, `iClaw-arm64.zip.blockmap`, and `latest-mac.yml` to a new
   GitHub Release manually.

## Website download link

The artifact names are version-less, so this URL is permanent:

```
https://github.com/iClawApp/iClaw/releases/latest/download/iClaw-arm64.dmg
```

Point the landing page's "Download for Mac" button at it.

## How auto-update works

`electron/updater.js` runs on launch (packaged builds only). It reads
`latest-mac.yml` from the latest GitHub Release, compares the version to the
running one, and if newer, downloads the `.zip` in the background and installs it
on the next quit (`autoInstallOnAppQuit`). macOS verifies the code signature, so
**every published build must be signed + notarized** or the update is rejected.
Update activity is logged to `~/.iclaw/logs/desktop.log`.

## Gotchas we hit (so you don't again)

- **`CSC_NAME` with the `Developer ID Application:` prefix** → electron-builder errors
  "remove prefix". Use just `Name (TEAMID)`.
- **Dangling `.bin` symlinks** after pruning devDeps from the server payload → break
  codesign. The build config already excludes `node_modules/.bin/**`.
- **Notarization stuck "In Progress"** is Apple's queue, not us. Check with
  `xcrun notarytool history --keychain-profile iclaw-notarize`.
- **Download size** (~331 MB dmg) is dominated by the Electron framework + the
  bundled stock Node (required because better-sqlite3 can't run on Electron's V8).
  Pruning only cuts the *installed* footprint.
