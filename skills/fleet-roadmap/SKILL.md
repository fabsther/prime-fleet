---
name: fleet-roadmap
description: Assign a Prime Fleet Roadmap step with @machine and launch it on its assigned Studio machine, using local revisions and synchronization checks.
---

# Fleet Roadmap

Requires the desktop `prime-fleet` CLI and the whole Fleet skills folder. Use fleet-machines first. Project selectors are an ID, syncId or exact name; prefer stable plan and step IDs.

```text
python skills/fleet-roadmap/scripts/roadmap.py assign --machine ALIEN18 --project Pieton --plan PLAN_ID --step STEP_ID --assign BAGUETTE
python skills/fleet-roadmap/scripts/roadmap.py launch --machine ALIEN18 --project Pieton --plan PLAN_ID --step STEP_ID
```

Both commands are simulations by default. Review their JSON, ask the user to approve the specific action, then repeat with `--confirmed`. Read requests are real; dry-run never sends a POST, including sync. A simulation cannot promise that a missing target step will synchronize.

Assignment preserves the rest of the note, removes prior standalone `@machine:` directives (case-insensitive) and appends exactly one using the Studio name. It sends `step.edit` with the revision just read. No step checks or plan-wide replacements.

Launch reads the source assignment, resolves the project copy by syncId (name only when absent), and optionally syncs the source then target only when each advertises `sync`. It rereads the target Roadmap, requires the same unchecked step text and note, and sends `roadmap/work` with that target's `expectedRevision`, a new `requestId`, and `targets:[{kind:"plan",planId,stepId}]`.

A 409, timeout, missing copy or changed step stops the action. Reread and reconcile; never retry automatically. Studio requestId retention is one hour and does not survive restart. A completion's machine comes from Studio's read-only `completion.machineId`, not its assignment or the machine serving the copy.
