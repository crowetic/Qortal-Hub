# Desktop builds controlled from Linux

These commands use the regular desktop `main` checkout. Hosted-access and daemon
branches retain their own packaging. The Windows Docker path produces
experimental test installers. It must produce a verified completion receipt
before an installer is shared. No command publishes a release or deploys a
service.

| Command                                    | Where compilation happens                      | Result                             |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------- |
| `./build-cross-docker.sh win`              | Linux x64 Docker with Windows tools under Wine | Windows x64 setup and portable EXE |
| `./build-cross-docker.sh mac --arch x64`   | Native Intel Mac GitHub runner                 | macOS DMG and ZIP                  |
| `./build-cross-docker.sh mac --arch arm64` | Native Apple Silicon GitHub runner             | macOS DMG and ZIP                  |

The Mac command uses a Docker controller to dispatch and retrieve a native
build. **It is not local macOS cross-compilation.** The current PyInstaller
freezer needs target-OS Python and libraries; Docker on Linux supplies no macOS
runtime. The renderer and Go transport can be compiled on Linux, but those
alone do not constitute a working Hub package. See
[electron-builder platform constraints](https://www.electron.build/v26/docs/features/multi-platform-build/)
and [PyInstaller platform requirements](https://pyinstaller.org/en/stable/).

## Windows: local Docker/Wine

Use a Linux x64 machine with Git, Node.js 22.12+, and a working Docker engine.
The host needs neither Windows, Python nor Go. The image provides Node 22,
Go 1.26.0, WineHQ 11 and checksum-verified Windows CPython 3.12.10. Wine 9 is
insufficient: Python's `CopyFile2` call aborts while building the Reticulum
package. The image uses signed WineHQ APT metadata and the standard Python
implementation.

Fresh builds run with Docker's init wrapper, disable unused Mono/Gecko installer
dialogs, and use a UTF-8 locale. These settings avoid headless startup stalls and
allow Windows Python to extract Unicode filenames from the Reticulum archive.
The source archive and Python filesystem functions remain unmodified.

```sh
git switch main
git pull --ff-only origin main
git status --short
docker info
./build-cross-docker.sh win
```

The script honors the current Docker context and `DOCKER_HOST`. Run `docker info`
in the same session to verify that it reaches the intended engine; the script
does not start services or change Docker settings.

You can inspect the target without contacting Docker:

```sh
./build-cross-docker.sh win --dry-run
```

The image builds with an empty context, keeping host dependencies and runtime
state out of its layers. The container reads the source checkout and copies
tracked working-tree files into temporary container storage; it excludes `.git`,
untracked files, ignored hosted leftovers and host `node_modules`. A developer
testing new source files must stage them first. Use a clean committed checkout
for a build intended for testers; dirty state is recorded in the receipt.

The pipeline installs the renderer for Linux and Electron dependencies for
Windows, builds/syncs the standard renderer, compiles the main process and
cross-compiles the Go transport. Windows Python under Wine freezes Reticulum
from the resolved Philreact source revision. It retains only the Windows x64
SQLite prebuild and installs Windows Sharp optional dependencies. A real
Windows Electron process under Wine exercises SQLite and PNG generation before
and after packaging; a missing/incompatible addon fails the build. This path
does not invoke a Linux rebuild of Windows native modules.

NSIS setup and portable launchers use x86 PE stubs even for x64 applications.
The build accepts those launcher stubs while requiring x64 application payloads
and successful native addon checks under the packaged Windows Electron process.

The source checkout and host npm projects remain untouched. Each build gets a
new output directory under `electron/dist/test-releases/win-x64-<signing>/`.
The npm/Electron download cache lives under
`${XDG_CACHE_HOME:-$HOME/.cache}/qortal-hub-cross/`. Earlier artifacts, including
the Linux AppImage, are retained.

Unsigned is the default. For Authenticode signing, privately export
`WIN_CSC_LINK` as a **local PFX file path** and `WIN_CSC_KEY_PASSWORD`, then run:

```sh
./build-cross-docker.sh win --signing signed
```

The PFX is mounted read-only and its password is passed by environment variable
name, not embedded in the command or image. Signed mode requires successful
electron-builder signing and `osslsigncode` verification against trusted CAs.
Windows certificate-store/thumbprint and hardware-provider signing should use
the [native Windows builder](test-releases.md); that store is not available in
the Linux container. No signing credential or certificate was supplied during
implementation, so credential-backed signing remains untested.

## macOS: Docker controller and native runner

The controller needs Docker, a clean `main` commit pushed to
`crowetic/Qortal-Hub`, and a privately exported `GH_TOKEN` with Actions write
and Contents read access to that fork. It does not reuse a host CLI login or
copy credentials into an image. The remote workflow builds unsigned/ad-hoc
packages; Developer ID signing/notarization uses the existing
[native Mac script](test-releases.md).

GitHub must first register the controller-enabled
`.github/workflows/desktop-test-releases.yml` on the repository's default
branch. At the last check, this fork still defaulted to `develop`, while these
changes were intentionally on `main`. The repository owner must either make
`main` the GitHub default branch or explicitly authorize synchronizing this
workflow to the chosen default branch. The scripts do not change that setting
or write another branch. This prerequisite also applies to the manual Actions
instructions in `test-releases.md`.
[GitHub's manual-workflow requirement](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

After registration and token setup:

```sh
./build-cross-docker.sh mac --arch x64
./build-cross-docker.sh mac --arch arm64
```

The controller checks the exact remote `main` commit, correlates its dispatch
with a unique request ID, watches that run and downloads only the matching
architecture's artifact. It checks source/architecture/signing provenance and
artifact sizes/hashes before writing `controller-run.json`. Files remain under
the local unique `electron/dist/test-releases/mac-<arch>-unsigned/` directory.
The remote build URL is printed for inspection or cancellation. Cancellation
of the local controller does not automatically cancel the remote job.

The Docker controller image was built and its Node/GitHub CLI tools ran
successfully. The Mac workflow could not be dispatched: no GitHub token was
available and default-branch registration was outstanding. Tests exercise its
CLI control flow with a fake GitHub CLI; no native Mac artifact has been verified.

## Completion, testing and recovery

Share only the top-level setup/portable EXE or DMG/ZIP files and their
`desktop-build.json`. A partial directory without a verified receipt is not a
completed release. The Windows receipt records `method: docker-wine-cross`,
source dirty state, platform/tool versions, Reticulum revision, packaged native
smoke results and artifact hashes. The Mac receipt retains
`method: native-test-release`; its separate controller marker records the run.
Both paths disable publishing and production update feeds.

Test the result on the actual target OS: launch, login, local Core access,
Q-App opening and Reticulum chat/reconnect. Wine component checks do not prove
that the Windows installer, firewall rules, audio devices or complete UI work
on Windows. Back up app/wallet data and retain the previous installer before
testing. Recovery is to close the test app and reinstall the previous version;
no hosted frontend or daemon rollout is involved.

On 2026-10-28, clean desktop source `fca10f9e` completed the unsigned Windows
Docker pipeline and produced both installers with a verified completion receipt.
The packaged Windows Electron 44.1.1 process loaded SQLite 3.53.4 and Sharp
0.34.5; frozen Reticulum 1.5.5 and the Go transport passed x64 payload checks.
The existing Linux Docker AppImage remained unchanged and passed its checksum.
Windows UI/installer testing on an actual Windows host and credential-backed
signing remain outstanding.

For repeatable orchestration checks:

```sh
npx vitest run electron/src/cross-docker-build.test.ts electron/src/mac-ci-controller.test.ts electron/src/test-release-build.test.ts electron/src/linux-docker-build.test.ts
```

The manual Actions workflow also has a `windows-docker-x64` target on an Ubuntu
runner, once default-branch registration is resolved. It exercises the real
Docker build and retains its release artifacts for 14 days.
