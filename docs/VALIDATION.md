# Validation · 13 October 2026

## Passed

- Frontend production build: TypeScript + Vite.
- Vitest: 16 pure-logic/controller tests.
- Installed Edge: 8 tests (desktop dark/light, tablet landscape/portrait, phone, per-run SSE cursor/reset/resume, null-session promotion, pending confirm questions).
- Rust: 7 tests (SSE framing/split UTF-8/limits, cursor, no Origin, URL/path checks, secret-free metadata, cross-process configuration locking).
- Rust Clippy: all targets, warnings denied.
- Fleet skills: 17 offline stdlib safety tests, including dry-run writes, GUI owner races, ambiguous acceptance, and manifest output preservation.
- Native CLI GET `/machine`: ALIEN18 4.3.3 (`computer-use`, `sync`) and BAGUETTE 4.3.2 (`computer-use`, no `sync`), both exit 0.
- Windows native webview: connected to both configured PCs, no JavaScript page errors; read-only project navigation observed with WebView2 CDP.
- Windows debug EXE and MSI built.
- Android ARM64 native Rust library and Keystore Kotlin plugin compiled; debug APK packaged with Gradle.
- Exact live tokens were checked against source: no matches. No token was committed or printed.

No Studio POST was sent to a real project during this implementation. Native calls made by browser regression tests are mocked in the test, not in production.

## Build notes

Android initialization selected API 37 by default. `android:prepare` pins the installed API 36.1 and sets `android.builder.sdkDownload=false`. It also disables Kotlin incremental compilation because the Cargo cache and project are on different drives. Java and Kotlin targets match.

Windows lacks symlink privilege. `android:build` first compiles through Tauri normally, then handles only that specific packaging failure by copying the freshly built ARM64 library and invoking Gradle with the already-completed Rust task excluded. No Developer Mode or other system setting was changed. Native symbols stay in Cargo target; the copied installable library is stripped with the installed NDK tool. Gradle could not locate its strip tool automatically, so its fallback was not relied on.

Windows CLI uses the console subsystem, including debug/release. The GUI may have a console window. Tokens are registered by stdin or hidden prompt; the compatibility token argument is supported but discouraged because OS process listings can expose it.

## Ponytail pass

Removed unused SSE/download wrappers, event DTOs, machine/interaction helpers, and the unused complete Roadmap mutation union/helper. Reused the tested campaign stop/message controllers in the shipped Roadmap instead of parallel owner/revocation logic. Kept no state/router/UI framework. The native Android vault plugin exists only because keyring has no Android backend and otherwise falls back to an insecure mock store.

## Artifacts

Paths are relative to this checkout and ignored by Git:

- `app/src-tauri/target/debug/prime-fleet.exe`
- `app/src-tauri/target/debug/bundle/msi/Prime Fleet_0.1.0_x64_en-US.msi`
- `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`
- `.local/screenshots/desktop-dark.png`, `desktop-light.png`, `tablet-landscape.png`, `tablet-portrait.png`, `phone.png`
- `.local/screenshots/native-machines.png`, `native-project.png` (point-in-time native captures; the project capture includes loading)

## Not yet validated

- Dedicated live write acceptance testing, including real SSE questions, stop/transfer, Roadmap conflicts, Computer Use authorization/revocation, and skill launches from Studio settings.
- The final Pieton host/guest campaign and its two player reports.
- Physical Xiaomi tablet installation, Tailscale routing, Android Keystore persistence, mobile downloads, and external display behavior.
- iOS generation/build/device operation. Mobile entry point, Keychain backend and iOS minimum version are configured; a Mac/Xcode is required.
- English is the current UI language; there is no full French translation table.

Sync remains capability- and permission-gated. No sync state enum is guessed. API v1 has no distributed conversation lock and no route to register a missing project. App-lifetime campaign state is not restored after quitting. These are not claimed as passed acceptance criteria.

## Artifact checksums (SHA-256)

- `app/src-tauri/target/debug/prime-fleet.exe` · 18,334,208 bytes · `f909d73f3902810f432f24a6d71097ffe8febaf2c305cf2112702addfae8ed2c`
- `app/src-tauri/target/debug/bundle/msi/Prime Fleet_0.1.0_x64_en-US.msi` · 6,451,200 bytes · `1f90cf5f89e3d24811f492731a1b33be377160bb7affdce8c5411416edf76a55`
- `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` · 38,946,637 bytes · `601756d5a258aa67d5a0916e35fc29fbb2a2287fcdb0a2e08a3569997fe001ad`

## Source size

Own app/runtime/build glue: 2,186 physical lines (984 React/CSS/controller lines; 1,154 Rust/Keystore plugin lines; 48 Android build glue lines). Skill implementations: 611 Python lines. Tests and unchanged Studio style assets are counted separately. No vendor/generated/build output is included.
