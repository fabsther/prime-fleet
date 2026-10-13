---
name: fleet-machines
description: List Prime Fleet machines, live Studio state and capabilities. Use before assigning work, moving a conversation or launching a multiplayer campaign.
---

# Fleet machines

Prerequisites: desktop Prime Fleet installed, `prime-fleet` on PATH, machines and tokens configured in the app's system vault. Add the whole `prime-fleet/skills` folder in Studio's skills settings on each PC. Keep the shared `_fleet.py` beside the four skill folders.

```text
python skills/fleet-machines/scripts/machines.py
```

The script calls `prime-fleet machines`, then `prime-fleet api <name> GET /api/v1/machine`. It prints the Studio name, machineId, version, capabilities and online/error state. It does not disclose machine configuration or tokens. A failed probe is not proof that the PC is off.

Use Studio names or machineIds for assignments. Do not infer capabilities from the version. `computer-use` and `sync` must be advertised. No token files, direct HTTP, internal routes or queued offline work.
