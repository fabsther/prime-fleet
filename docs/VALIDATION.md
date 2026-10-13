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

## Live and tablet update · 13 October 2026

The initial no-POST baseline above is superseded for the explicitly authorized fleet-sandbox only. See [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md) for the per-check table and remaining scope/device limits. Current tests: 16 Vitest, 10 Edge UI, 17 skill safety, 11 Rust runtime/SSE, 1 Rust bridge, 1 Kotlin Invoke/GCM. Frontend, Android compile/package, desktop package, Clippy and desktop release check pass. Native AndroidKeyStore hardware/device persistence and actual tablet authentication remain unproven until parent retest.

Current artifact hashes (supersede earlier baseline):

- `app/src-tauri/target/debug/prime-fleet.exe` · 18,441,216 bytes · `643e8c6f0e9b259ca903956ea8d580508c8dac6c672660cae466e2fff712a1d4`
- `app/src-tauri/target/debug/bundle/msi/Prime Fleet_0.1.0_x64_en-US.msi` · 6,488,064 bytes · `b71b82f5a2d851513b9fc20cea9553bd46580f56dc402676d6e09ca2eeaf1ba8`
- `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` · 39,039,685 bytes · `95c34b0513aa1bfa4e1814c26044e1ffcadf16acd475f8cf987a7cf4f8973a0f`

## Strict token and new-scope update

Current tests: 12 Rust runtime/SSE and 11 Edge UI; both pass. Strict token grammar and input/composition regressions reject trailing backticks/whitespace before storage. New ALIEN18 and BAGUETTE tokens were registered by stdin without printing token text. Explicit-sync same-session transfer and both CU authorize/revoke checks now pass; see final table. Latest APK: `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` · 39,040,141 bytes · SHA-256 `34a26c5b9bcbc75be21f3599aeeb77ea7fdfb5a0dfad39cd2f75f199739b4329`. Physical IME input path remains a device-retest item.

## Final strict-input delivery

- `app/src-tauri/target/debug/prime-fleet.exe` · 18,441,728 bytes · SHA-256 `c74a1c315507b622107a9634263de57cd479b604107cafb492d40c951ef5a251`
- `app/src-tauri/target/debug/bundle/msi/Prime Fleet_0.1.0_x64_en-US.msi` · 6,488,064 bytes · SHA-256 `9eb08b924e8244212c1715ed275daf4f7e38f06adfd016ddf37777123620b5d2`
- `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` · 39,040,141 bytes · SHA-256 `34a26c5b9bcbc75be21f3599aeeb77ea7fdfb5a0dfad39cd2f75f199739b4329`

## Physical Android authentication retest

Parent reports CONNECTED with the final strict-input APK. The apparent token corruption was a harness error: `adb keyevent 111` (ESC), intended to hide Gboard, inserted a trailing backtick. It was not caused by secure storage or Authorization construction. Strict token validation caught it clearly and is retained. Earlier pending-authentication notes are superseded; cold-start persistence and other device checks are not implied by this result.

## Tablet portrait and FR/EN delivery

- Tablet classification is shortest viewport side ≥600 CSS px. Portrait tablets show two equally bounded vertical zones; landscape tablets keep side-by-side zones; phones remain single in both orientations. Nine layout checks passed, including four portrait sizes, both phone orientations, rotations, independent scrolling and no page overflow.
- French is the default. FR/EN selectors persist locally and update app-owned copy, status/help/errors, dates, numbers and plural counts. User/agent content and technical request values are unchanged. Locale switches retain forms, drafts, expanded plans and editor values.
- Combined headless Edge suite: 23/23. Vitest: 21/21 (including five pure translation regressions). Android debug build passed.
- New APK: `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` · 39,052,429 bytes · SHA-256 `703d8335950a0aa2f49eac16e1d90bad532c908d2c97ba13ee6fc49e91a08079`. This supersedes earlier APK hashes. Physical portrait/localization retest is pending parent confirmation.
- Matching Windows build: `app/src-tauri/target/debug/prime-fleet.exe` · 18,449,920 bytes · SHA-256 `c18dd95534e7494311533b00a1a39b0d76d6b69b046f8903ea108cbc9af67357`.
- Matching Windows build: `app/src-tauri/target/debug/bundle/msi/Prime Fleet_0.1.0_x64_en-US.msi` · 6,496,256 bytes · SHA-256 `f999218535e744facbc9c8c9937d30c053cd0e2017899e4dfa8ac6738bd0f561`.
