# Prime Fleet

A direct controller for Prime Agent Studio PCs over Tailscale. Conversations belong to a project, not to a machine.

## Requirements

- Prime Agent Studio 4.3.1 or later on each PC, with public API remote access enabled.
- Tailscale connected on the controller and each PC. Use the Studio HTTPS address.
- A remote access token for each machine. Fleet never stores tokens in JSON or sends them to a browser fetch.
- For builds: Node 24, Rust, the platform compiler, and Tauri 2 prerequisites. Android also needs Android Studio's JBR, SDK API **36.1**, and NDK 27.3.

## Desktop setup

```sh
cd app
npm ci
npm run tauri dev
npm run tauri build
```

The **Machines** screen adds a connection. Tokens go into Windows Credential Manager, macOS/iOS Keychain, or Linux Secret Service. Android uses a small native AndroidKeyStore plugin: AES-GCM ciphertext only is stored in app preferences. `keyring` has no Android backend; its mock fallback is not used. See [native storage decision](app/src-tauri/README.md).

A metadata file named `machines.json` lives in the OS config directory under `dev.primefleet.app`. It contains only `id`, `name`, and `url`. Changing the URL requires a new token. Forgetting a machine deletes its token.

## CLI

The desktop executable is also the CLI. Put its directory on `PATH` for the skills.

```sh
prime-fleet machines
prime-fleet add ALIEN18 https://alien18.example.ts.net --token-stdin
prime-fleet api ALIEN18 GET /machine
prime-fleet api ALIEN18 GET /api/v1/projects
```

`add` accepts a hidden prompt, stdin, or an optional token argument. Prefer stdin or the prompt: command-line arguments can appear in process listings and shell history. Output is JSON; errors go to stderr and return exit code 1. No write is retried automatically. In Git Bash, set `MSYS2_ARG_CONV_EXCL='*'` to prevent rewriting `/machine` into a Windows path.

Windows retains the console subsystem so scripts can read stdout. Launching the GUI can also show a console window.

## Scopes

Create tokens in Studio with only the required scopes and project access:

| Scope | Use |
| --- | --- |
| `read` | Machines, projects, history, runs and Roadmap |
| `runs:write` | Start/stop runs, steer/follow up, answer questions |
| `roadmaps:write` | Edit the Roadmap and launch its work |
| `files:download` | Save referenced files |
| `computer:write` | Authorize/revoke Computer Use for a player |
| `sync:write` | Proposed sync support, only when the machine advertises `sync` |

For a machine with `sync`, also enable **Token allows sync:write** in its Fleet card. This is an explicit permission setting, not an API claim. Without sync capability/permission on both ends, Fleet compares the last message. Different or missing copies block the send.

## Workspace

- Projects are grouped by `syncId`; projects without one use an exact-name fallback.
- Conversations are deduplicated by session ID. Read history from the newest copy. A machine-colored dot shows the last agent.
- The composer lists online machines with the project. Active runs lock the normal selector and route messages to their owner. **Continue elsewhere** offers waiting or stopping before transfer. Waiting never sends a draft automatically.
- Native SSE has explicit cursor resume. A failed write or revision conflict is shown, reread where needed, and never silently replayed.
- Roadmap edits carry `expectedRevision`. `@machine:` assigns a step. Completion shows the Studio-reported machine.
- An `@campaign` plan has at most eight players and two per PC. One `@gui` player per PC is allowed. Launches are sequential on each machine and parallel between machines. Computer Use prechecks never take another owner's control.
- Each player writes `outputs/multitest/<campaignId>/player-<k>.md`. Results do not check steps automatically. Validate reports and add the summary to the plan journal.
- Pane selectors can show Conversation, Roadmap, Files, or Machines. Campaign controls survive switching panes within the app. Desktop has a project sidebar. Tablets have two panes, side by side in landscape and stacked in portrait. Phones have one pane; wider external displays use the same width-based rules.

## Install the Fleet skills

In Prime Agent's **skills** setting, add the absolute path to this repository's `skills` folder on each PC. Put the installed desktop executable on `PATH`. A `git pull` updates the skills without changing Studio.

Included: `fleet-machines`, `fleet-roadmap`, `fleet-conversation`, and `multiplayer-testing`. Scripts use Python's standard library and call only `prime-fleet machines/api`. Mutations are **dry-run by default**; real writes require `--confirmed`.

See [skills setup and examples](skills/README.md). Conversation transfer conservatively refuses if a configured fleet member cannot be inspected; remove unrelated offline machines if needed. There is no distributed conversation lock in API v1, so an external run can still race a final check.

## Android

Use the already installed SDK. The preparation step pins API 36.1 and disables automatic SDK downloads.

```sh
cd app
# Set JAVA_HOME to Android Studio/jbr, ANDROID_HOME to the SDK, NDK_HOME to NDK 27.3.
npm run tauri android init
npm run android:build
```

This builds a debug ARM64 APK. Kotlin incremental compilation is disabled to avoid cross-drive Cargo cache errors. Generated projects are ignored; `android:prepare` reapplies the installed SDK settings after initialization. For other architectures, run preparation then `npm run tauri -- android build --debug --target <target>`.

### Windows without Developer Mode

`app/scripts/android-build.mjs` first uses the normal `tauri android build` path. Machines with symlink privilege keep that path. Only when Windows rejects the library symlink, the script copies the freshly built ARM64 `.so` into `jniLibs`, strips its native debug symbols with the installed NDK, and runs Gradle assemble with the completed Rust task excluded. Full native symbols stay in the Cargo target, and JavaScript debugging stays enabled. No Developer Mode or other system setting change is needed.

Tokens must be registered on the Android device; the desktop vault is not copied. Downloads are saved in app-private storage on mobile. Xiaomi HyperOS may require **Install via USB** in developer options. Physical tablet/Tailscale/Keystore operation must be checked on the device.

## iOS configuration

The Tauri mobile entry point, native Keychain backend, bundle identifier, and iOS 14 minimum version are configured. On a Mac with Xcode and signing:

```sh
cd app
npm run tauri ios init
npm run tauri ios build
```

No iOS build or device test is claimed from Windows.

## Checks

```sh
cd app
npm test
npm run build
npm run test:ui        # Uses installed Microsoft Edge; native IPC is mocked only in these tests.
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cd ..
python -m unittest discover -s skills/tests -v
```

UI tests cover desktop dark/light, tablet landscape/portrait, and phone; screenshots go to `.local/screenshots`. No tests mutate real projects. Live POST acceptance testing requires a dedicated test project and explicit authorization. The final Pieton multiplayer campaign is not included in the offline checks.

## API boundaries and limits

Only Studio public API v1 is used. All Studio traffic goes through Rust because Studio rejects webview requests with an `Origin` header. HTTPS origins are validated, redirects are disabled, and tokens cannot be read through a JavaScript command.

Sync routes are proposed, not assumed. ALIEN18 currently advertises `sync`; BAGUETTE does not, so cross-machine continuation uses last-message comparison. The sync state vocabulary is not guessed. Idempotency lasts one hour and does not survive Studio restart. Fleet never retries an uncertain write.

API v1 cannot register a missing project on a machine. There is no push service, automatic machine setup, or advanced offline cache. A campaign is kept only for the app's current lifetime; do not close Fleet before collecting or stopping it.

## Style and license

MIT. The unmodified Studio CSS, icons and theme assets are included with their [MIT license](app/src/studio/LICENSE.txt), copyright 2026 zerr0o. Fleet composes their `ps-` markup and tokens without a UI library. React state and small pure helpers replace router/state frameworks. Markdown uses `react-markdown` and GFM, without raw HTML.

[Specification](docs/SPEC.md) · [Decisions](docs/DECISIONS.md)
