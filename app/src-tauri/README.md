# Native backend

Tauri 2 owns all Studio traffic. React never receives a saved token and never contacts Studio directly. Requests use HTTPS, do not send `Origin`, do not follow redirects, and accept only `/api/v1` paths (short `/machine` paths are expanded). Writes are never retried. Errors preserve the HTTP status, Studio code and `currentRevision`.

## Commands

- `machines()` → `{id,name,url}[]`
- `save_machine({machine,token?})`, `remove_machine({machineId})` → metadata array
- `api({machineId,method,path,body?})` → JSON; failures reject `{status?,code,message,currentRevision?}`
- `stream({machineId,path,after?})` → stream ID; events `fleet-stream` carry `{streamId,machineId,path,event,id}`; `fleet-stream-end` carries an optional error. `stop_stream({streamId})` cancels a subscription.
- `download({machineId,path,filename})` → `{path,bytes}`. Saves a sanitized, uniquely prefixed name in Downloads on desktop, or app-private downloads on mobile. Never overwrites a file or leaves a failed partial download as a finished file.

The SSE parser handles split UTF-8, CR/LF/CRLF, heartbeats, multi-line data and the `replay_truncated` marker. Resume explicitly with the last received ID (`after` and `Last-Event-ID`); reconnect is never automatic. Subscribe to events before invoking `stream`. A silent connection times out after 90 seconds.

## Storage decision

`keyring` 3.6 has native Windows Credential Manager and macOS/iOS Keychain backends. It **does not support Android**: an unsupported platform silently defaults to a mock store. We do not use that fallback. The small local `tauri-plugin-fleet-secrets` uses AndroidKeyStore with a non-exportable AES-GCM key, random IVs and machine ID as authenticated data. SharedPreferences contains only authenticated ciphertext. A lost/reset Keystore key requires registering the token again. Linux uses persistent Secret Service with encrypted D-Bus transport (`async-secret-service`, `crypto-rust`). No plaintext fallback exists.

The JSON at the OS app config directory `dev.primefleet.app/machines.json` contains only machine metadata. Its schema rejects token fields. Changes use atomic replacement and OS file locks shared by the GUI and CLI. Tokens cannot be read through any JavaScript command. New machines and changed URLs require a token.

## Desktop CLI

The same executable handles CLI arguments without opening the webview:

```text
prime-fleet machines
prime-fleet add ALIEN18 https://alien18.example.ts.net --token-stdin
prime-fleet api ALIEN18 GET /machine
prime-fleet remove ALIEN18
```

`add` reads the token from stdin (pipe it from your local secret source), or a hidden terminal prompt. An optional final token argument is supported for compatibility, but can appear in OS process listings and shell history. Prefer stdin. In Git Bash, set `MSYS2_ARG_CONV_EXCL='*'` to stop MSYS from rewriting `/machine` as a Windows filesystem path. Native PowerShell/cmd and Python subprocess calls need no workaround. Tokens are never printed. Errors go to stderr; results are JSON on stdout. Windows intentionally uses the console subsystem in debug **and release**, so CLI stdout works in terminals and redirected child processes; launching the GUI can therefore show a console window.

## Builds

From `app/`, with the existing Rust toolchain and platform SDKs:

```text
npm install
npm run tauri dev
npm run tauri build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri android init
npm run tauri android dev
npm run tauri android build
```

Set `JAVA_HOME` to Android Studio's JBR and `ANDROID_HOME` / `NDK_HOME` to the installed SDK/NDK. The Tauri CLI supplies target linkers. Do not hard-code local SDK paths in Cargo. The local Keystore plugin is included in Android builds. Android min SDK is 24.

On a Mac with Xcode and signing configured:

```text
npm run tauri ios init
npm run tauri ios dev
npm run tauri ios build
```

The same Rust library exposes Tauri's mobile entry point. iOS uses native Keychain. Android/iOS generated projects are not source-of-truth and are git-ignored. Platform compilation and device validation must be reported separately from desktop tests; an iOS build cannot be validated on Windows.
