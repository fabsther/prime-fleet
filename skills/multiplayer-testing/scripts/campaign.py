import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import argparse
import json
from _fleet import (CLI, FleetError, path_id, request_id, active, owns, output, run_main)


def control(cli, manifest, action, message=None):
    if action != "status" and manifest.get("dryRun"):
        raise FleetError("This is a dry-run manifest. It contains no accepted campaign runs.")
    if action == "send" and (not message or len(message) > 262144):
        raise FleetError("Message must contain 1..262144 characters.")
    results, verified = [], []
    for player in manifest.get("players", []):
        if not player.get("run"):
            continue
        stored = player["run"]
        item = {"machine": player["machine"], "stepId": player["stepId"]}
        results.append(item)
        try:
            run = cli.get(player["machine"], "/runs/" + path_id(stored["id"]))
            if any(run.get(k) != stored.get(k) for k in ("id", "projectId", "sessionId", "machineId")):
                raise FleetError("Run identity changed. Refusing mutation.")
            item["run"] = run
            verified.append((player, run, item))
            if action == "status":
                if player.get("gui") and player.get("computerUseCapability", True):
                    item["computerUse"] = cli.get(player["machine"], "/computer-use")
                if run.get("sessionId"):
                    item["files"] = cli.pages(player["machine"], "/sessions/" + path_id(run["sessionId"]) + "/files")
            elif action == "send" and active(run):
                if not run.get("sessionId"):
                    raise FleetError("Accepted run has no conversation yet.")
                item["message"] = cli.write(player["machine"], "/sessions/" + path_id(run["sessionId"]) + "/messages", {
                    "requestId": request_id(), "mode": "follow_up", "message": message})
            elif action == "stop" and active(run):
                # v1 stop body is exactly {}, unlike run/message request bodies.
                item["stop"] = cli.write(player["machine"], "/runs/" + path_id(run["id"]) + "/stop", {})
        except (FleetError, KeyError) as exc:
            item["error"] = str(exc)
    if action == "stop":
        # Request every stop before any Computer Use revocation.
        for player, run, item in verified:
            if not player.get("gui") or not player.get("computerUseCapability", True) or item.get("error"):
                continue
            try:
                state = cli.get(player["machine"], "/computer-use")
                if not owns(state, run):
                    item["computerUse"] = "Not this campaign's owner; left unchanged."
                    continue
                if state.get("cleanupPending") or state.get("cleanupFailed"):
                    raise FleetError("Computer Use cleanup uncertain; manual intervention needed.")
                target = {"sessionId": run["sessionId"]} if run.get("sessionId") else {"runId": run["id"]}
                item["computerUse"] = cli.write(player["machine"], "/computer-use", {
                    "enabled": False, "expectedRevision": state["revision"], **target})
            except (FleetError, KeyError) as exc:
                item["error"] = str(exc)
    return {"campaignId": manifest["campaignId"], "action": action,
            "dryRun": not cli.confirmed, "players": results}


def main():
    parser = argparse.ArgumentParser(description="Read campaign status, message live players, or stop accepted runs.")
    parser.add_argument("action", choices=["status", "send", "stop"])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--message")
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    output(control(CLI(args.confirmed), manifest, args.action, args.message))


if __name__ == "__main__":
    run_main(main)
