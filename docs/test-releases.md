# Desktop test releases

Use the regular desktop `main` branch. `hosted-access` and `hub-daemon` have
separate packaging and are rejected by this builder. No server deployment is
involved. The scripts never publish a GitHub Release or configure a production
auto-update feed. The application version stays unchanged; filenames identify
these as test builds and the receipt identifies the source commit.

| Target              | Build host                                     | Output                    | Signing choices                                   |
| ------------------- | ---------------------------------------------- | ------------------------- | ------------------------------------------------- |
| Windows x64         | Windows x64                                    | NSIS setup + portable EXE | Unsigned, Authenticode signed                     |
| macOS Intel         | Intel Mac with x64 Node/Python                 | DMG + ZIP                 | Unsigned, Developer ID signed, signed + notarized |
| macOS Apple Silicon | Apple Silicon Mac with arm64 Node/Python       | DMG + ZIP                 | Ad-hoc, Developer ID signed, signed + notarized   |
| Linux x64           | Existing Docker/Podman engine                  | AppImage                  | Existing Docker build, checksum receipt           |
| Linux arm64         | Native arm64 Docker, or configured QEMU/binfmt | AppImage                  | Existing Docker build, checksum receipt           |

The native host requirement comes from frozen Reticulum/Python, SQLite and
other native modules. These are not portable JavaScript-only packages. See
[electron-builder platform constraints](https://www.electron.build/v26/docs/features/multi-platform-build/)
and [PyInstaller platform builds](https://pyinstaller.org/en/stable/usage.html#supporting-multiple-operating-systems).
Windows arm64, 32-bit and universal macOS builds are outside this test-build
script's supported targets. Build macOS architectures separately; the older
universal command is not used by this workflow.

## Prepare a native host

Install Git, Node.js 22.12+ with npm, Python 3.9+ and Go 1.26+. Node and Python
must match the architecture being packaged. Python 3.12 and Node 22 are selected
in the manual CI workflow. The build downloads dependencies and the Reticulum
source specified by the existing Python builder. Its `BUNDLE_READY` marker
records the resolved Reticulum source metadata; moving upstream references mean
these builds are not guaranteed to be bit-for-bit reproducible.

On Windows, install Visual Studio 2022 Build Tools with **Desktop development
with C++**, its x64 compiler and Windows SDK. Install Python from python.org
with the launcher or put it on PATH. On macOS, install Xcode Command Line Tools
(`xcode-select --install`); notarization additionally needs Apple's `notarytool`.
Use an ordinary writable source checkout and run builds as your own user.

From the repository root, check the branch and tools:

```sh
git switch main
git pull --ff-only origin main
git status --short
node --version
go version
```

The scripts run `npm ci` in **both** npm projects, install the Electron CLI,
rebuild the renderer, sync Capacitor, rebuild Electron and SQLite, compile the
Go transport and freeze Reticulum on that host. Generated `electron/build` and
`electron/app` are replaced; previous release artifacts are preserved. Only
this run's native payloads enter the package. The selected Python can be
overridden with `QORTAL_PYTHON_BINARY`; Go with `QORTAL_GO_BINARY`.
Use exported signing variables rather than `electron/electron-builder.env`.
The script rejects that file because the builder CLI would reload its settings
after the signing mode was selected.

## Unsigned test builds

Windows PowerShell:

```powershell
.\build-windows.ps1
# Alternatively, without changing PowerShell execution policy:
npm run build:test-release -- --platform win --arch x64 --signing unsigned
```

On the matching Mac architecture:

```sh
./build-macos.sh --arch arm64 --signing unsigned   # Apple Silicon
./build-macos.sh --arch x64 --signing unsigned     # Intel Mac
```

Only run the command matching your host. The default architecture is Node's
architecture. Unsigned mode removes certificate and Apple credentials from the
child environment and disables certificate discovery. Apple Silicon still
needs ad-hoc signatures; this mode uses no Developer ID certificate or Apple
notarization. It does not establish publisher trust. Downloaded unsigned/ad-hoc
apps may be blocked by OS security policy; prefer a notarized Mac build for
external testers. See [macOS signing modes](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

Linux keeps the owner-approved Docker route:

```sh
./build-appimage.sh
# arm64; requires native arm64 or preconfigured host emulation:
cd electron
npm run electron:make-arm-docker-appimage
```

Do not substitute a native Linux build if the container engine is unavailable.

## Windows signing

Choose **one** credential source. For a supported PFX credential, set
`WIN_CSC_LINK` to its path and `WIN_CSC_KEY_PASSWORD` through your private local
environment or secret manager. For a certificate/private key already available
through the Windows certificate store or a hardware token's provider, set
`QORTAL_WIN_CERT_SHA1` to its 40-character thumbprint. The provider/token must
allow `signtool` to use the private key. Do not put keys or passwords in Git,
command arguments, scripts or shared logs.

```powershell
.\build-windows.ps1 -Signing signed
```

Missing credentials fail before dependency installation. Signed mode requires
electron-builder signing to succeed, requests SHA-256 signing, includes the
native EXE/DLL/addon payloads and verifies the resulting setup and portable EXE
with `Get-AuthenticodeSignature`. Certificate-chain, timestamp-service and token
access errors fail the build. A valid signature does not guarantee SmartScreen
reputation. See [electron-builder Windows signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

## macOS signing and optional notarization

Install a **Developer ID Application** certificate **and its private key** in
your unlocked signing keychain. Use `security find-identity -v -p codesigning`
to find its full name, then set `QORTAL_MAC_SIGN_IDENTITY` to that name, including
the `Developer ID Application:` prefix. A certificate imported only at the
electron-builder stage is too late: PyInstaller must sign libraries embedded
inside its onefile executables while freezing them. This workflow deliberately
uses the preinstalled keychain identity for both steps. See
[PyInstaller embedded binary signing](https://pyinstaller.org/en/stable/feature-notes.html#macos-binary-code-signing).

```sh
./build-macos.sh --signing signed
```

This signs the application, native runtime payloads and DMG, verifies the app's
signature against the requested identity, and **does not submit it to Apple**.
It creates DMG/ZIP packages rather than PKG installers, so a separate Developer
ID Installer certificate is unnecessary.

For signing **and Apple notarization**, also provide `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in your private environment:

```sh
./build-macos.sh --signing notarized
```

Selecting `notarized` explicitly submits the signed app to Apple's service.
Missing credentials fail early. The build uses electron-builder's built-in
notarization, validates the stapled app ticket and checks Gatekeeper assessment.
It disables the older hook to avoid duplicate submissions or a silently skipped
notarization. The ordinary signed mode ignores Apple credentials even if set.

## Inspect and retrieve builds

You can inspect any target from Linux without native tools or credentials:

```sh
npm run build:test-release -- --platform mac --arch arm64 --signing notarized --dry-run
```

A dry run prints configuration only. Real Windows/macOS builds write a unique
directory under `electron/dist/test-releases/<platform>-<arch>-<signing>/`.
Share its top-level EXE, DMG or ZIP files **and** `desktop-build.json`. The
receipt is written only after packaging, required runtime files, requested
signing/notarization checks and SHA-256 calculation succeed. It records source
branch/commit/dirty state, tool versions, signing mode and artifact hashes.
Do not treat a partial output directory without a receipt as a completed build.
Build from a clean committed checkout before sharing a test release.

For machines you do not own, open the writable fork's **Actions → Desktop test
releases → Run workflow**, select **main**, and choose one target or all three.
The manual workflow uses native Windows x64, Intel Mac and Apple Silicon Mac
runners, builds unsigned/ad-hoc packages, and retains downloadable artifacts for
14 days. It uses no signing secrets, creates no Release and does not run on
push. Alternatively, after authenticating `gh`:

```sh
gh workflow run desktop-test-releases.yml --repo crowetic/Qortal-Hub --ref main -f target=all
gh run list --repo crowetic/Qortal-Hub --workflow desktop-test-releases.yml
gh run download RUN_ID --repo crowetic/Qortal-Hub --dir ./release-builds/RUN_ID
```

Signed builds currently run on your credential-equipped native hosts; the
manual workflow does not import signing certificates.

## Test and recover

On the target OS, verify the receipt/hash, launch the app, check the displayed
version, then test login, local Core connectivity, Q-App opening and Reticulum
chat/reconnect. With a compatible Core, test the new local signing flow using a
dedicated test wallet and a deliberately small transaction. A successful
packaging check does not prove those live integrations work.

These are normal desktop apps and use the normal desktop data directory. Back
up your wallet and app data before testing; keep the previous working installer
or app. The Windows test installer preserves app data on uninstall and does not
launch the app automatically. To recover, close the test app and reinstall the
previous working version; restore your saved data only if needed. No server
restart, hosted frontend deployment or daemon rollout is required.

Local verification while changing these scripts:

```sh
npx vitest run electron/src/test-release-build.test.ts electron/src/linux-docker-build.test.ts electron/src/private-transport-build.test.ts
```

The orchestration tests use fake native tools in disposable Git checkouts. The
electron-builder schema checks additionally require `npm ci` in `electron/`;
the real Go checks require Go. Native packaging and signing must still be
validated on the corresponding Windows/macOS hosts.
