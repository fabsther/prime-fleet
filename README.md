# Prime Fleet

Pilot a fleet of [Prime Agent Studio](https://github.com/zerr0o/prime-agent-studio) PCs from Windows, macOS, Linux, Android and iOS, through the Studio public API v1 over Tailscale.

- Conversations belong to the project, not to a machine: continue one on any machine that has the project.
- Assign Roadmap steps to machines (`@machine:`) and launch them there.
- Multiplayer test campaigns in the Roadmap (`@campaign`, one step per player, `@gui` for the player that drives the desktop).
- A set of Prime Agent skills (`skills/`) that also works from Studio on the desktop, without changing Studio.

Status: specification stage. See [docs/SPEC.md](docs/SPEC.md) and [docs/DECISIONS.md](docs/DECISIONS.md).

Stack: React + Vite + Tauri 2. The interface follows the Prime Agent Studio style (MIT).

License: MIT.
