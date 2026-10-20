# Qortal Hub — agent guide

**Owner branch exception (2026-10-20):** Keep standalone daemon/API work on
`hub-daemon`. Publish the hosted browser interface, its matching daemon browser
transport and deployment packaging on `hosted-access`. These are separate,
long-lived branches with different runtime and deployment requirements. Integrate
their shared foundation only when the owner requests it. The NuQloud-wide `main`
default does not apply to this repository; do not create `main` as a delivery
target.

Desktop/web/mobile client for the Qortal blockchain, plus Reticulum-based
peer-to-peer chat and voice. GPL-3.0. React 19 + TypeScript + Vite 7 + MUI 7,
wrapped by Capacitor into an Electron desktop app and an Android app.

The repo is a single npm project at the root (the renderer) with a **second,
separate npm project in `electron/`** (the Electron main process). They have
their own `package.json` and `node_modules`. Changes to renderer code only reach
the desktop app after a `cap sync`.

## Commands

Root (renderer):

| Command                 | What                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `npm run dev`           | Vite dev server on `http://localhost:5173/` — browser only, no Reticulum |
| `npm run build`         | Production build into `dist/`                                            |
| `npm test`              | Vitest watch mode                                                        |
| `npx vitest run <path>` | Run one test file — preferred while iterating                            |
| `npm run coverage`      | Vitest with coverage                                                     |
| `npm run lint`          | ESLint, `--max-warnings 0`                                               |
| `npm run format`        | Prettier over the whole repo                                             |

Desktop (needs Python 3.9+ and Git on PATH):

```bash
npm run build                                # or npm run dev for the web part
npx cap sync @capacitor-community/electron   # REQUIRED after web/native changes
cd electron && npm install && npm run electron:start
```

Packaging lives in `electron/`: `electron:make-win`, `electron:make-mac`,
`electron:make-lin-docker`, `electron:make-arm-docker`. Linux release artifacts
should use the Docker variants so native binaries build against an older glibc.

There is no typecheck script; `tsc` runs via `vite-plugin-checker` during dev.

## Layout

```text
src/
  components/   382 files — UI, grouped by feature (Chat/, Group/, Apps/, QortalLand/, ...)
  lib/          call/, dm/, group-call/, reticulum/, webrtc/ — transport + protocol logic
  hooks/        useReticulumGroupChat, useVoiceCall, useAuth, ...
  atoms/        Jotai global state
  contexts/     React contexts (GroupCallContext, CallSwitchGuardContext, ...)
  i18n/         i18next setup + locales/<lang>/<namespace>.json
  qortal/       Qortal Core API calls, q-app request handling
  qdn/          QDN publish/fetch + encryption
  transactions/ signed blockchain transactions
  background/   POW + background tasks
  utils/        events bus, storage, chat helpers
  test/         Vitest setup + mocks for Electron/native modules
electron/src/   Electron main: reticulum-*.ts, group-call.ts, chat-db.ts, core.ts
electron/resources/presence_bridge.py   Python bridge to the Reticulum daemon
docs/           architecture docs — read these before touching Reticulum or calls
```

### The Reticulum path

```text
Renderer (React)  → window.electronAPI.reticulum*() / window.groupCall.*()
Electron main     → reticulum-daemon.ts, reticulum-bridge.ts, group-call.ts
Python bridge     → presence_bridge.py  (fd3/fd4 binary IPC)
rnsd              → Reticulum Network Stack daemon
```

Reticulum features **do not work in the browser dev server** — they need the
Electron shell. See `docs/reticulum.md` and `docs/group-audio-calls.md`.

## Conventions

**i18n is mandatory.** Every user-visible string goes through i18next — including
`aria-label`, placeholders, tooltips, and error messages. See the `i18n` skill in
`.agents/skills/i18n/` and `docs/i18n_languages.md`. Large parts of
`components/QortalLand/` and the `Reticulum*` chat components are still
hardcoded English and are being migrated; do not copy that pattern.

**State.** Jotai atoms in `src/atoms/` for global state. Cross-component
signalling uses a DOM CustomEvent bus, not a store:

```ts
import {
  executeEvent,
  subscribeToEvent,
  unsubscribeFromEvent,
} from '../utils/events';
```

Always unsubscribe in the effect cleanup.

**Styling.** MUI `sx` with `theme.palette.*` — light and dark themes both ship
(`src/styles/theme-light.ts`, `theme-dark.ts`). Do not hardcode hex colors.

**Formatting.** Prettier: single quotes, semicolons, 80 columns, 2 spaces, es5
trailing commas. Run `npm run format` rather than hand-aligning.

**TypeScript is not strict** — `strict: false`, `noImplicitAny: false`. Don't
assume null-safety is enforced by the compiler; check at runtime.

**Tests.** Vitest + jsdom, ~144 test files colocated next to their subject as
`*.test.ts(x)`. Files under `electron/**` run in the `node` environment instead.
Native and Electron modules are aliased to fakes in `src/test/mocks/` — extend
those rather than mocking ad hoc. Test setup: `src/test/setup.ts`.

## Agent config — skills and commands

**Definitions live in `.agents/`; `.claude/` symlinks to them.** Claude Code
reads only `.claude/`, so the links are what make the config load.

```text
AGENTS.md                          the file you are reading
CLAUDE.md            → AGENTS.md   loaded unconditionally every session

.agents/skills/<name>/SKILL.md     skills — edit here
.agents/skills/<name>/scripts/     tooling a skill owns, run from the repo root
.agents/commands/<name>.md         slash commands — edit here
.agents/settings.json              shared project settings — edit here

.claude/skills        → ../.agents/skills
.claude/commands      → ../.agents/commands
.claude/settings.json → ../.agents/settings.json
.claude/settings.local.json        real file, machine-local permissions — never commit
```

Edit the `.agents/` originals, never the links. Skills load on demand when their
`description` matches the task; commands are invoked as `/<name>`.

Currently present: the `i18n` skill and the `write_tests` command.

The `i18n` skill owns the four locale scripts in
`.agents/skills/i18n/` — `i18n_scan_hardcoded.py`, `i18n_add_keys.py`,
`i18n_apply_translations.py` and `i18n_sort.py`. Invoke them as
`python3 .agents/skills/i18n/<name>.py` from the repo root; they find
`src/i18n/locales/` themselves. They used to live in a top-level `scripts/`
directory, which is gone.

Personal, cross-project equivalents live in `~/.claude/skills/` and
`~/.claude/commands/`.

**`.claude/` is the only discovery path.** `.agents/` and `.github/` are not —
`.github/` belongs to GitHub and Copilot, `.agents/` is a third-party installer
convention. Files there are silently ignored unless a `.claude/` symlink points
at them, which is precisely why the links above exist. Note the near-miss:
`.claude/agents/` (subagent definitions) is real; a top-level `.agents/` is not.

If skills or commands stop loading, check the symlinks first — a fresh clone
will not have them, since `.claude` is git-ignored.

## Git workflow

Choose the branch for the requested Hub variant before editing:

- `hub-daemon`: standalone headless Hub daemon/API and Reticulum integration.
- `hosted-access`: browser interface, authenticated real-time daemon transport,
  static-site/deployment packaging and hosted-access compatibility. This branch
  retains the older hosted-access history and includes the matching daemon
  implementation needed to build the hosted package. Do not merge between these
  variants automatically; the owner explicitly authorized this hosted update.
- `develop` / `master`: upstream development and stable/release history. Do not
  merge daemon or hosted-access changes here without explicit owner direction.

Commit and push standalone daemon work to `origin/hub-daemon` and hosted-access
work to `origin/hosted-access`. Preserve these branches separately; do not rename,
collapse, merge or retire them as routine cleanup. Do not create or recreate
`main` as a delivery target. This repository-specific owner instruction overrides
ecosystem-wide instructions to start from, create or deliver to `main`.

Check the current branch, tracking remote, outgoing commits and dirty state before
changing branches. Preserve unfinished work. Use an isolated detached worktree
when needed rather than moving unrelated changes between Hub variants.

Completed work follows the standing commit-and-push authorization in the NuQloud task delivery section below.

## Gotchas

- Renderer changes are invisible to Electron until `npx cap sync @capacitor-community/electron`.
- First Electron run downloads a Reticulum runtime venv into
  `electron/resources/reticulum-runtime/venv`. If it breaks:
  `cd electron && rm -rf resources/reticulum-runtime/venv && npm run bundle:reticulum-venv`.
- Vite workers are built as ES modules (`worker.format: 'es'`) because the
  audio-decrypt worker dynamically imports WASM — don't switch it to `iife`.
- `src/components/QortalLand/QortalLand.tsx` is ~11k lines. Search within it
  rather than reading it whole.
- Some legacy paths are gated by `src/constants/featureFlags.ts`
  (`isDisabledLegacy`).

## Docs worth reading first

`docs/development.md` · `docs/contribution.md` · `docs/reticulum.md` ·
`docs/group-audio-calls.md` · `docs/i18n_languages.md` ·
`docs/reticulum-chat-sync-architecture.md` · `docs/qortalland-asset-standard.md`

## NuQloud workspace locations

On Crowetic's development machine, this repository's canonical source checkout is
`/home/crowetic/git-repos/gitea/crowetic/Qortal-Hub`.
The current ecosystem map is
`/home/crowetic/git-repos/gitea/crowetic/NuQloud-Nextcloud/docs/nuqloud-repository-map.md`
and its machine-readable source is `/home/crowetic/git-repos/gitea/crowetic/NuQloud-Nextcloud/config/nuqloud-repositories.json`.
Use these canonical paths for new work. Old workspace paths may be compatibility
symlinks; legacy copies and installed app trees are separate reconciliation targets.

## NuQloud task delivery

The repository owner gives standing authorization to commit and push completed
work in NuQloud and its surrounding repositories. This applies to this task and
future tasks unless the user explicitly requests otherwise. Preserve existing
project-specific task IDs, independent review and CI rules.

**Qortal Hub branch exception:** The Git workflow section above determines the
delivery branch. The NuQloud-wide `main` default does not apply here. Standing
commit-and-push authorization applies on the correct existing task branch;
independent review and applicable CI checks still run before delivery.

- At task start, inspect the repository root, branch, tracking remote and dirty
  state. Identify the canonical source checkout before editing a duplicate,
  installed app or upstream reference. Preserve unrelated local work.
- Complete the requested implementation and relevant verification. Update
  documentation, changelogs and versions when the repository requires them.
  For documentation-only work, report that no runtime behavior changed.
- Review the diff and stage only files or hunks belonging to this task. Never
  sweep existing edits, generated assets, credentials or ignored runtime state
  into a commit. Do not create empty commits. If the same file contains unrelated
  changes, isolate the task hunks or use a separate worktree.
- Create focused commits with clear imperative subjects, normally under 72
  characters. Name the affected component and concrete behavior; avoid generic
  messages such as "updates" or "fix stuff". Explain the problem, resulting
  behavior and meaningful validation in the body when useful. Follow required
  task-ID prefixes and existing commit conventions.
- Start new work from the verified current remote tip of the intended existing
  task branch. Preserve its history and local edits. An isolated detached
  worktree may protect local work without creating a new branch. A missing
  `main` is expected here; do not create it or use it as a fallback.
- Push those commits to the intended writable project remote and matching task
  branch without asking for routine confirmation. Check outgoing commits first
  so unrelated unpublished history is not pushed accidentally. Never push to an
  upstream project merely because it is named `origin`. If server protection
  requires a PR or blocks a direct push, report that concrete blocker; do not
  silently create a branch or bypass it.
- Keep `hub-daemon` and `hosted-access` even after a merge unless the owner
  explicitly authorizes deleting them. Before any authorized branch deletion,
  verify its exact tip is preserved on the intended pushed branch and that the
  branch has not advanced. Retain local recovery refs and worktrees containing
  unfinished work. Never delete an unmerged or upstream branch.
- Use normal pushes. Do not force-push, reset/discard work, rewrite shared
  history, bypass hooks or merge protections, or silently change a remote to
  make delivery succeed. Resolve safe routine issues; if authentication,
  permissions or divergent history blocks pushing, retain the commit and
  report the exact blocker and safe next command. Never claim a failed push
  succeeded. Do not leave completed task changes uncommitted merely because
  older workflow defaults expected the owner to commit manually.
- A push is not permission to deploy. Check whether pushing the intended branch
  triggers deployment. If it would deploy without authorization for that rollout,
  report the trigger and retain the local commit; do not choose another branch
  as a workaround. Do not copy code to servers, patch live files, change live
  configuration, run migrations, or restart/reload services without explicit
  authorization for that specific rollout. The owner deploys to `monsta`
  through Git and the existing lifecycle scripts.
- Finish with what changed and why, verification and limitations, commit IDs,
  remote/branch and push status, and exact rollout steps appropriate to the
  changed components. Reuse existing automation with the target's actual env
  file, topology and options. Include readiness checks and a recovery/rollback
  path when runtime behavior or data changes. If no suitable script exists,
  give precise manual steps, or add a repeatable, idempotent script when useful.
  Documentation/rules-only changes require no service restart or deployment.
