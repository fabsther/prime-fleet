---
name: fleet-conversation
description: Continue a project conversation on another Prime Fleet machine, or send steer/follow_up to its live run. Checks active owners and synchronization before starting work.
---

# Fleet conversation

Requires the desktop `prime-fleet` CLI and the whole Fleet skills folder. Choose `--source` as the machine with the latest persisted history (inspect project sessions/updatedAt and last agent first). The target must already have the project; Fleet cannot register one through public v1.

```text
python skills/fleet-conversation/scripts/conversation.py continue --source ALIEN18 --target BAGUETTE --project Pieton --session SESSION_ID --message "Continue the task."
python skills/fleet-conversation/scripts/conversation.py send --source ALIEN18 --project Pieton --session SESSION_ID --mode steer --message "Use the smaller fix."
```

These are dry-runs. Ask the user to approve before adding `--confirmed`. The script uses only CLI commands and never reads tokens or calls HTTP itself.

- It reads all online machines' paginated runs. A live conversation stays on its actual owning machine; `send` ignores a target choice and routes to that owner.
- To move a live conversation, wait for its run to finish. Or use `continue ... --stop-active --confirmed` after approval. This requests a stop and exits. Verify completion, then invoke continue again; there is no automatic stop-and-relaunch.
- Once idle, it syncs source then target only if each advertises `sync`. The proposed sync extension is absent from the v1-4 schema; no state enum is assumed.
- It verifies that the conversation belongs to the selected project on both PCs and compares the last persisted message, paging through the complete history. A missing copy or different last message means **not yet synchronized**. This is also the fallback without `sync`.
- It checks for a new live run again before POSTing `{requestId,sessionId,message}` to the target project's `/runs`.

Public v1 does not provide a distributed session lock. Runs that start outside Fleet can still race the final check. A machine that cannot be read cannot be certified idle. The script refuses transfer or live messaging until all configured machines can be read (remove unrelated unavailable machines from the app configuration if needed). No automatic retries, guessed sync states, blind 409 replay, or follow-up sent to a stale machine.
