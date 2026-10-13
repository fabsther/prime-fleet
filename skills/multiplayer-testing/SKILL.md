---
name: multiplayer-testing
description: Create, launch and follow multiplayer/coop/online test campaigns across Prime Fleet PCs. A Roadmap @campaign has one unchecked player step per role, @machine assignments and optional @gui desktop control. Use for campagne de test or simulated human-like players, one or two per machine.
---

# Multiplayer testing with Prime Fleet

Port of the Studio multiplayer-testing workflow. Requires the desktop `prime-fleet` CLI, its configured system vault, and the whole Fleet skills folder. No `fleet-machines.json`, token files, Python packages, direct HTTP or Studio changes. Use fleet-machines, fleet-roadmap and fleet-conversation as needed.

## Campaign format

Create a project Roadmap plan using Studio's normal Roadmap authoring tools, with explicit user approval for mutations. The summary contains a standalone, case-insensitive `@campaign` line. All other summary lines are common instructions. Each unchecked step is a player; its text is the role, its note starts with exactly one standalone `@machine: <Studio name or machineId>`, followed by numbered actions and observable success criteria. A standalone `@gui` marks desktop control. Do not check steps automatically.

```text
@machine: BAGUETTE
@gui
1. Join the host. Success: both players appear in the session HUD.
2. Move and interact. Success: the host sees the changed object state.
```

Limits: 1..8 unchecked players, at most two per PC, at most one `@gui` player per PC. Every player must have a known online machine and the same project copy. Headers plus common instructions must fit 4000 characters; put long protocols in repo docs. Assign regular tasks through fleet-roadmap; keep campaign notes' machine directive first when authoring.

## Author checklist (fill from the project's docs, never guess)

1. **Same code everywhere:** expected commit SHA; each player checks `git rev-parse HEAD` and `git status --porcelain`. Fetch/checkout the SHA only with a clean tree and project permission. Otherwise stop and report. Never commit, push, stash or reset.
2. **Build:** executable/build procedure and verification that each PC uses the intended binary. Budget for first C++/shader builds (Pieton can take 30–90 minutes).
3. **Network:** host PC, Tailscale IP or MagicDNS name, port and protocol. Host listens first. Guests retry every 15 seconds for at most 10 minutes, then report failure. Players do not communicate directly; write everything they need into the plan.
4. **Actions:** numbered actions for each role, each with an observable criterion (HUD, log marker, screenshot). Use human-like pacing and vary actions within these bounds.
5. **Evidence:** each player writes `outputs/multitest/<campaignId>/player-<k>.md`, with timings, steps, logs, screenshot paths and failures, and cites the path in its final answer. The launcher injects the exact per-player path.
6. **End:** close only game processes that player started. Respect AGENTS.md, saves/assets and forbidden actions.
7. **Computer Use:** GUI players wait at most two minutes for authorization, then report and stop. They never enable it themselves. Set backend/model locally in Studio; Fleet does not change them.

## Launch

```text
python skills/multiplayer-testing/scripts/launch_campaign.py --machine ALIEN18 --project Pieton --plan PLAN_ID --campaign-id a1b2c3d4e5f6
```

This is a dry-run: real GETs, zero POSTs (even sync). Review it and ask the user to approve. Then add `--confirmed --output outputs/multitest/a1b2c3d4e5f6/launch.json`. The output path must not exist. Keep the manifest: accepted run identities are needed for follow-up. Do not repeat an accepted launch; requestId retention is one hour and is lost on restart.

The launcher validates all players before writes, then reads global Computer Use on GUI machines. Any owner, including a hidden owner, busy controller or uncertain cleanup blocks preflight. It never revokes or takes over another target. Without `computer-use` capability it gives a manual reminder and never calls that route; the player still has a two-minute wait limit.

It syncs only PCs that advertise `sync`, then requires matching target campaign content. Dispatch is sequential per PC and parallel across PCs. Before **each** dispatch it rereads the target Roadmap and uses its `expectedRevision`. Its requestId is `cmp_<12 hex campaignId>_<stepId>`, truncated to 100; collisions are rejected. Header:

```text
Campagne de test <campaignId> — joueur <k>/<N> : <role> (machine <M>).
Joueurs : 1) ALIEN18 Joueur 1 — hôte ; 2) BAGUETTE Joueur 2 — invité
Consignes communes :
<summary without @campaign>
```

This goes in `instructions`; Studio adds the step text/note itself. After a GUI player is accepted, Fleet rereads ownership and POSTs `/computer-use` with `{enabled:true,expectedRevision,runId}` only if free and supported. A race or error is recorded with the accepted run, and other players continue. No automatic retries or step checks.

## Follow-up

```text
python skills/multiplayer-testing/scripts/campaign.py status --manifest outputs/multitest/a1b2c3d4e5f6/launch.json
python skills/multiplayer-testing/scripts/campaign.py send --manifest outputs/multitest/a1b2c3d4e5f6/launch.json --message "Report your current state."
python skills/multiplayer-testing/scripts/campaign.py stop --manifest outputs/multitest/a1b2c3d4e5f6/launch.json
```

`status` reads runs, ownership and conversation file references. `send` and `stop` simulate unless explicitly approved with `--confirmed`. Messages go to live accepted players with `follow_up`. Stop requests every accepted live run's stop first (v1 requires exactly `{}`), then rereads Computer Use and revokes only a matching campaign owner using a fresh revision. A session target allows revocation after its run ends. Hidden, different or uncertain owners are never revoked.

Download reports through the Fleet app after producers finish; compare them and write a synthesis into the plan journal using a fresh Roadmap revision. Check player steps **only when the user validates**. An error or timeout needs a reread and a human decision, never blind replay. This skill supplies infrastructure; the project supplies the game protocol.
