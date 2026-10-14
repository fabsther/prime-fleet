import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launch_campaign import computer_state
import argparse
import json
from _fleet import (CLI, FleetError, path_id, request_id, active, owns, output, run_main)


def status(cli, manifest):
    # One snapshot per target project / GUI machine, even with two own players.
    run_checks, computer_states, accepted = {}, {}, {}
    players = [p for p in manifest.get("players", []) if p.get("run")]
    for player in players:
        run = player["run"]
        if (isinstance(run, dict) and all(isinstance(run.get(k), str) and run[k]
                for k in ("id", "projectId", "machineId"))
                and player.get("projectId", run["projectId"]) == run["projectId"]):
            accepted.setdefault((player["machine"], run["projectId"], run["machineId"]), set()).add(run["id"])

    def project_check(player, stored):
        key = (player["machine"], stored["projectId"], stored["machineId"])
        if key not in run_checks:
            check = {"phase": "status", "machine": key[0], "projectId": key[1], "status": "unavailable"}
            run_checks[key] = check
            try:
                runs = cli.pages(key[0], "/runs")
                conflicts = []
                for run in runs:
                    if not isinstance(run, dict):
                        raise FleetError("Active run identity is unknown.")
                    if not active(run):
                        continue
                    if not isinstance(run.get("projectId"), str) or not run["projectId"]:
                        raise FleetError("Active run identity is unknown.")
                    if run["projectId"] != key[1]:
                        continue
                    if (not isinstance(run.get("id"), str) or not run["id"]
                            or run.get("machineId") != key[2]):
                        raise FleetError("Active run identity is unknown.")
                    if run["id"] not in accepted.get(key, set()):
                        conflicts.append(run["id"])
                check.update(status="blocked" if conflicts else "clear", conflictingRunIds=conflicts)
                if conflicts:
                    check["error"] = "Active same-project run: " + ", ".join(conflicts) + ". Never take over."
            except (FleetError, KeyError, TypeError, ValueError) as exc:
                check.update(status="unavailable", error=str(exc))
        return run_checks[key]

    results = []
    for player in players:
        stored = player["run"]
        item = {"machine": player["machine"], "stepId": player["stepId"],
                "requestId": player.get("requestId"), "acceptedRun": stored,
                "run": stored, "runChecks": [], "status": "unavailable",
                "computerUseOwnershipCheck": {"phase": "status", "status": "not-requested"}}
        results.append(item)
        errors, current = [], None
        try:
            if (not isinstance(stored, dict) or not all(isinstance(stored.get(k), str) and stored[k]
                    for k in ("id", "projectId", "machineId"))
                    or player.get("projectId", stored["projectId"]) != stored["projectId"]):
                raise FleetError("Accepted run identity is unknown.")
            item["projectId"] = stored["projectId"]
            check = project_check(player, stored)
            item["runChecks"].append(check)
            if check.get("error"):
                errors.append(check["error"])
            run = cli.get(player["machine"], "/runs/" + path_id(stored["id"]))
            if (not isinstance(run, dict) or any(run.get(k) != stored[k] for k in ("id", "projectId", "machineId"))
                    or (run.get("sessionId") is not None and (not isinstance(run["sessionId"], str) or not run["sessionId"]))
                    or (stored.get("sessionId") is not None and run.get("sessionId") != stored["sessionId"])):
                raise FleetError("Run identity changed. Current status cannot be verified.")
            current = run
            item["run"] = run  # A previously null sessionId may now be available; manifest stays unchanged.
        except (FleetError, KeyError, TypeError, ValueError) as exc:
            errors.append(str(exc))
        if player.get("gui"):
            check = {"phase": "status", "status": "unavailable"}
            item["computerUseOwnershipCheck"] = check
            if not player.get("computerUseCapability", True):
                check.update(status="unsupported", error="Computer Use capability unavailable.")
            else:
                alias = player["machine"]
                if alias not in computer_states:
                    try:
                        computer_states[alias] = computer_state(cli, {"alias": alias})
                    except (FleetError, KeyError, TypeError, ValueError) as exc:
                        computer_states[alias] = str(exc)
                state = computer_states[alias]
                if isinstance(state, str):
                    check["error"] = state
                else:
                    item["computerUse"] = state
                    check["state"] = state
                    owner = state["owner"] or {}
                    certain = (current is not None and state["machineId"] == current["machineId"]
                               and state["supported"] and not state["ownerHidden"]
                               and not state["cleanupPending"] and not state["cleanupFailed"])
                    exact = (certain and owner.get("runId") == current["id"]
                             and owner.get("projectId") == current["projectId"]
                             and owner.get("machineId", current["machineId"]) == current["machineId"]
                             and owner.get("sessionId", current.get("sessionId")) == current.get("sessionId"))
                    if exact and state["enabled"] and active(current):
                        check["status"] = "verified"
                    elif (certain and not active(current) and state["owner"] is None
                          and not state["enabled"] and not state["busy"]):
                        check["status"] = "released"
                    else:
                        check.update(status="blocked", error="Computer Use owner missing, changed or uncertain. Never take over.")
            if check.get("error"):
                errors.append(check["error"])
        if current is not None and current.get("sessionId"):
            try:
                item["files"] = cli.pages(player["machine"], "/sessions/" + path_id(current["sessionId"]) + "/files")
            except (FleetError, KeyError, TypeError, ValueError) as exc:
                errors.append(str(exc))
        item["status"] = "blocked" if errors else "ok"
        if errors:
            item["error"] = "; ".join(errors)
    return {"campaignId": manifest["campaignId"], "action": "status",
            "dryRun": not cli.confirmed, "players": results}


def control(cli, manifest, action, message=None):
    if action == "status":
        return status(cli, manifest)
    if manifest.get("dryRun"):
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
            if action == "send" and active(run):
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
