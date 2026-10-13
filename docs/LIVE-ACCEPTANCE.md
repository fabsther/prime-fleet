# Live acceptance · fleet-sandbox · 13 October 2026

Authorized test project only: `p_ea411feaa57f0dc3758a80a9112014d7`, sync ID `6c4f29eb-f74b-46b6-a028-6c675acc42e3`.

## Current results

| Check | Result | Evidence |
| --- | --- | --- |
| New conversation on ALIEN18 | Pass | Real UI → Rust POST, completed run `7020d6bf-14d2-43ea-b9f3-386b2e43566a`; 20 native SSE events; 3 history messages. |
| Same conversation selector transfer to BAGUETTE | Blocked | Source sync returns HTTP 403 `insufficient_scope`; no new target run was launched. Awaiting `sync:write` tokens. |
| Agent question + answer | Pass, select method | `allowQuestions=true`; real agent requested a yes/no confirmation, Studio emitted `method=select`; UI answered and run completed. Boolean `method=confirm` is tested offline, not claimed live. |
| Stop active run | Pass | UI stopped a run waiting for a question; `86373738-5331-430e-8efe-966cfd3d81b5` became `stopped`. |
| Roadmap create/assign/launch/completion | Pass | Found and fixed missing explicit initialization (`409 roadmap_uninitialized`). Created 2 assigned steps. Shipped `launchStep` through native invoke launched BAGUETTE; session `01a136f6-b6dd-745c-86fd-09cb35fb043b` linked; step done with BAGUETTE completion attribution. Copy was background-synced by Studio; explicit sync remains blocked. |
| 2-player no-GUI campaign | Pass | Packaged production UI launched one player per PC; both completed, native SSE observed for both. Reports `outputs/multitest/df68e77d0fde/player-1.md` and `player-2.md` referenced in files. Stop all clicked after both completed; this does not claim stopping an active two-player campaign. |
| Computer Use authorize/revoke | Blocked | GET shows both PCs supported, available, disabled and unowned. Authorize fails 403 `insufficient_scope` before changing state. Awaiting `computer:write`. No desktop input/capture was requested. |
| Four Fleet skills | Pass | `fleet-machines` read; conversation/Roadmap/campaign dry-runs produced safe previews, campaign for both PCs. One explicit Roadmap assignment `--confirmed` succeeded, revision 3→4. |
| Cleanup | Pass at checkpoint | All own test runs completed or stopped. Zero active sandbox runs on both PCs. Both Computer Use states disabled/unowned, no cleanup pending/failed. No other project was mutated. |

## Devices and bugs

- Parent reported Android Password Manager attempting to save the token: input is now masked text / one-time-code, no form submit semantics, no autocorrect/capitalization. Save reads the actual input DOM value. Native required/URL checks remain.
- Parent reported Tailscale-off connection failure: GET network failures now say `Machine injoignable (vérifiez Tailscale)`. POST uncertainty and server HTTP errors are preserved.
- Parent reported Android 401 with apparently correct token: root cause is not yet proven. Vault reads, Tauri Invoke JSON and AES-GCM packing/AAD are regression-tested. Tokens are normalized and validated; save requires exact read-back or verified rollback. Native request headers are sensitive, built through one helper. Debug-only diagnostics expose byte counts and SHA-256 fingerprints, never token text. Physical Keystore and server receipt still require device retest.

Vite rebuild/HMR can reset the dev page during UI automation. Final UI checks use the packaged production native WebView2 instead. The headless Edge suite is isolated and uses mocks only for its offline tests; live acceptance never replaces native invoke.

## Final cleanup checkpoint

- ALIEN18: sandbox run statuses completed, completed, stopped, completed; Computer Use disabled, owner null, cleanupPending=false, cleanupFailed=false.
- BAGUETTE: sandbox run statuses completed, completed; Computer Use disabled, owner null, cleanupPending=false, cleanupFailed=false.
