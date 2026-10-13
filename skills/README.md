# Fleet skills

Add this entire folder to Prime Agent Studio's skills settings. Update with `git pull`.
The desktop `prime-fleet` executable must be on PATH, with machines and tokens already
configured in its app vault. Python 3.9+; standard library only. No token files.

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
