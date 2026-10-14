# Fleet skills

Add this entire folder to Prime Agent Studio's skills settings. Update with `git pull`.
The desktop `prime-fleet` executable must be on PATH, with machines and tokens already
configured in its app vault. Fleet API scripts use Python 3.9+ and the standard library only. No token files.

Windows controller input is optional: run `python skills/multiplayer-testing/scripts/gamepad.py setup` once per PC for an isolated `vgamepad` environment and ViGEmBus (one-time UAC approval). Use `gamepad.py run` for games that need sticks, triggers, or controller buttons; Computer Use supplies eyes and game-window focus. Do not repeat setup per campaign.

Run the commands in each SKILL.md from the repository root, or use absolute script paths.
Writes are simulations unless the user approves and you add `--confirmed`. Dry-run does
perform read-only CLI requests. Never automatically retry an ambiguous real write.

Run the offline safety checks from the repo root:

```text
python -m unittest discover -s skills/tests -v
```

The tests use an in-memory fake CLI. They do not connect to Studio, Tailscale or the vault.

Token scopes: `read`, `runs:write`, `roadmaps:write`, `computer:write` as needed;
`sync:write` only for servers advertising sync. Download through the app needs `files:download`.
