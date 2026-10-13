# Live acceptance · fleet-sandbox · 13 October 2026

Authorized test project only: `p_ea411feaa57f0dc3758a80a9112014d7`, sync ID `6c4f29eb-f74b-46b6-a028-6c675acc42e3`.

## Current results

| Check | Result | Evidence |
| --- | --- | --- |
| New conversation on ALIEN18 | Pass | Real UI → Rust POST, completed run `7020d6bf-14d2-43ea-b9f3-386b2e43566a`; 20 native SSE events; 3 history messages. |
| Same conversation selector transfer to BAGUETTE | Pass | After new scoped tokens were registered by stdin: shipped selector/controller synced ALIEN18 then BAGUETTE, continued the same session `01a136e8-4cd2-729d-81f3-495e54f6c990`. Completed on BAGUETTE; both histories contain the same 6 messages and UI shows `Last agent: BAGUETTE`. |
| Agent question + answer | Pass, select method | `allowQuestions=true`; real agent requested a yes/no confirmation, Studio emitted `method=select`; UI answered and run completed. Boolean `method=confirm` is tested offline, not claimed live. |
| Stop active run | Pass | UI stopped a run waiting for a question; `86373738-5331-430e-8efe-966cfd3d81b5` became `stopped`. |
| Roadmap create/assign/launch/completion | Pass | Found and fixed missing explicit initialization (`409 roadmap_uninitialized`). Created 2 assigned steps. Shipped `launchStep` through native invoke launched BAGUETTE; session `01a136f6-b6dd-745c-86fd-09cb35fb043b` linked; step done with BAGUETTE completion attribution. Copy was background-synced by Studio; explicit sync remains blocked. |
| 2-player no-GUI campaign | Pass | Packaged production UI launched one player per PC; both completed, native SSE observed for both. Reports `outputs/multitest/df68e77d0fde/player-1.md` and `player-2.md` referenced in files. Stop all clicked after both completed; this does not claim stopping an active two-player campaign. |
| Computer Use authorize/revoke | Pass on both PCs | With replacement tokens, authorized then revoked for the idle sandbox session. Each revision advanced 0→1→2. Final GET: disabled, owner null, busy=false, cleanupPending=false, cleanupFailed=false. No agent run, desktop input or capture was requested. |
| Four Fleet skills | Pass | `fleet-machines` read; conversation/Roadmap/campaign dry-runs produced safe previews, campaign for both PCs. One explicit Roadmap assignment `--confirmed` succeeded, revision 3→4. |
| Cleanup | Pass at checkpoint | All own test runs completed or stopped. Zero active sandbox runs on both PCs. Both Computer Use states disabled/unowned, no cleanup pending/failed. No other project was mutated. |

## Devices and bugs

- Parent reported Android Password Manager attempting to save the token: input is now masked text / one-time-code, no form submit semantics, no autocorrect/capitalization. Save reads the actual input DOM value. Native required/URL checks remain.
- Parent reported Tailscale-off connection failure: GET network failures now say `Machine injoignable (vérifiez Tailscale)`. POST uncertainty and server HTTP errors are preserved.
- Parent reported Android 401 with apparently correct token: root cause is not yet proven. Vault reads, Tauri Invoke JSON and AES-GCM packing/AAD are regression-tested. Tokens are normalized and validated; save requires exact read-back or verified rollback. Native request headers are sensitive, built through one helper. Debug-only diagnostics expose byte counts and SHA-256 fingerprints, never token text. Physical Keystore and server receipt still require device retest.

Vite rebuild/HMR can reset the dev page during UI automation. Final UI checks use the packaged production native WebView2 instead. The headless Edge suite is isolated and uses mocks only for its offline tests; live acceptance never replaces native invoke.

## Final cleanup checkpoint

- ALIEN18: 4 sandbox run records, all completed or stopped; Computer Use disabled, owner null, cleanupPending=false, cleanupFailed=false, revision 2.
- BAGUETTE: 3 sandbox run records, all completed or stopped; Computer Use disabled, owner null, cleanupPending=false, cleanupFailed=false, revision 2.

## Android input follow-up

Parent device diagnostics isolated the 401 to a correct 46-byte token plus one trailing backtick (47 bytes). Storage round-trip was stable; this was invalid input, not proven Keystore corruption. The field now uses masked ordinary text, autocomplete off, input events and composition-end handling; Save is disabled while composing. It no longer uses one-time-code or a DOM-ref save read. UI and native boundaries require exact `pa_[A-Za-z0-9_-]+`; invalid characters/whitespace produce a clear error before storage and are not stripped. A synthetic trailing-backtick + composition regression passes. Physical IME/Password Manager behavior awaits parent retest.
