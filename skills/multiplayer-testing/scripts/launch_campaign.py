import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import argparse
import json
import re
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from _fleet import (CLI, FleetError, inventory, machine_named, project_named, project_copy,
                    roadmap, plan_named, steps, step_named, assignment, marker, sync,
                    same_step, work, active, computer_free, output, run_main)


def players_for(plan, machines, campaign_id):
    if not re.fullmatch(r"[0-9a-f]{12}", campaign_id):
        raise FleetError("campaignId must be 12 lowercase hexadecimal characters.")
    if not marker(plan.get("summary", ""), "campaign"):
        raise FleetError("Plan summary needs a standalone @campaign line.")
    players = []
    for step in steps(plan):
        if step.get("done"):
            continue
        machine = machine_named(machines, assignment(step))
        players.append({"step": step, "machine": machine, "gui": marker(step.get("note", ""), "gui")})
    if not 1 <= len(players) <= 8:
        raise FleetError("Campaign needs 1..8 unchecked player steps.")
    if any(n > 2 for n in Counter(p["machine"]["machineId"] for p in players).values()):
        raise FleetError("At most two players per machine.")
    if any(n > 1 for n in Counter(p["machine"]["machineId"] for p in players if p["gui"]).values()):
        raise FleetError("At most one @gui player per machine.")
    common = "\n".join(line for line in plan.get("summary", "").splitlines()
                       if not re.fullmatch(r"\s*@campaign\s*", line, re.I)).strip()
    roster = "; ".join(f"{k}) {p['machine']['name']} {p['step']['text']}" for k, p in enumerate(players, 1))
    for k, player in enumerate(players, 1):
        player["number"] = k
        player["requestId"] = f"cmp_{campaign_id}_{player['step']['id']}"[:100]
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", player["requestId"]):
            raise FleetError("Invalid campaign requestId; use a valid stable step ID.")
        player["instructions"] = (
            f"Campagne de test {campaign_id} — joueur {k}/{len(players)} : {player['step']['text']} "
            f"(machine {player['machine']['name']}).\nJoueurs : {roster}\nConsignes communes :\n{common}\n"
            f"Rapport : outputs/multitest/{campaign_id}/player-{k}.md. Citer ce chemin dans la réponse finale.\n"
            "Computer Use : attendre au plus 2 minutes seulement si aucun autre propriétaire, puis signaler et arrêter. "
            "Ne jamais l'activer soi-même. "
            "If another agent session owns Computer Use OR a game instance already runs ON THIS MACHINE, "
            "report and STOP without taking control. Never stop that session or game instance.")
        if len(player["instructions"]) > 4000:
            raise FleetError("A player header and common instructions exceed 4000 characters.")
    ids = [p["requestId"] for p in players]
    if len(set(ids)) != len(ids):
        raise FleetError("Truncated campaign requestIds collide. Use shorter step IDs.")
    return players


def same_campaign(source, target):
    # Compare relevant instruction content, not local completion attribution/session links.
    return (source.get("summary") == target.get("summary") and
            len(steps(source)) == len(steps(target)) and
            all(same_step(a, b) for a, b in zip(steps(source), steps(target))))


def check_runs(cli, machine, project, accepted_ids, checks, phase):
    # Only exact run IDs accepted by this invocation are ours, never a session ID.
    check = {"phase": phase, "machine": machine["alias"], "projectId": project["id"],
             "status": "unavailable"}
    checks.append(check)
    runs = cli.pages(machine["alias"], "/runs")
    if any(not isinstance(r, dict) or not isinstance(r.get("projectId"), str)
           or not r["projectId"] or not isinstance(r.get("id"), str) or not r["id"] for r in runs):
        check["status"] = "unknown"
        raise FleetError("Run identity is unknown on " + machine["alias"] + ". Reread before launch.")
    conflicts = [r for r in runs if r["projectId"] == project["id"] and active(r)
                 and r["id"] not in accepted_ids]
    check.update(status="blocked" if conflicts else "clear",
                 conflictingRunIds=[r["id"] for r in conflicts])
    if conflicts:
        raise FleetError("Active same-project run on " + machine["alias"] +
                         ": " + ", ".join(str(r.get("id", "unknown")) for r in conflicts) +
                         ". Report and stop; never take over or stop another session.")


def computer_state(cli, machine):
    state = cli.get(machine["alias"], "/computer-use")
    flags = ("supported", "enabled", "busy", "ownerHidden", "cleanupPending", "cleanupFailed")
    if (not isinstance(state, dict) or any(type(state.get(key)) is not bool for key in flags) or "owner" not in state
            or type(state.get("revision")) is not int or state["revision"] < 0
            or not isinstance(state.get("machineId"), str) or not state["machineId"]
            or (machine.get("machineId") is not None and state["machineId"] != machine["machineId"])
            or (state["owner"] is not None and (not isinstance(state["owner"], dict) or not state["owner"]))):
        raise FleetError("Computer Use ownership state is unknown. Never take it over.")
    return state


def launch(cli, machines, source, project, plan, campaign_id):
    players = players_for(plan, machines, campaign_id)
    groups = {}
    warnings = []
    preflight = []
    for player in players:
        machine = player["machine"]
        groups.setdefault(machine["machineId"], []).append(player)
        if player["gui"]:
            if "computer-use" not in machine.get("capabilities", []):
                warnings.append(f"{machine['name']}: no computer-use capability. Enable locally if possible; player stops after 2 minutes.")
            else:
                state = computer_state(cli, machine)
                computer_free(state)
                if not state["supported"]:
                    warnings.append(f"{machine['name']}: Computer Use unsupported; manual setup needed.")
    # All target copies and project runs must be readable and safe before ANY writes (even sync).
    copies = {key: project_copy(cli, group[0]["machine"], project) for key, group in groups.items()}
    for key, group in groups.items():
        check_runs(cli, group[0]["machine"], copies[key], set(), preflight, "preflight")
    sync_results = []
    result = sync(cli, source, project)
    if result:
        sync_results.append(result)

    def dispatch(group):
        machine = group[0]["machine"]
        local_project = copies[machine["machineId"]]
        results = []
        accepted_ids = set()
        blocked = None
        try:
            if machine["machineId"] != source["machineId"]:
                result = sync(cli, machine, local_project)
                if result:
                    results.append({"sync": result, "machine": machine["alias"]})
        except FleetError as exc:
            blocked = str(exc)
        # Sequential on this PC. Each acceptance can change the Roadmap revision.
        for player in group:
            item = {"machine": machine["alias"], "projectId": local_project["id"],
                    "stepId": player["step"]["id"], "number": player["number"],
                    "gui": player["gui"], "requestId": player["requestId"],
                    "status": "not-dispatched", "runChecks": [],
                    "computerUseCapability": "computer-use" in machine.get("capabilities", []),
                    "computerUseOwnershipCheck": {"status": "not-granted" if player["gui"] else "not-requested"}}
            if blocked:
                item["error"] = "Machine group blocked by previous safety failure: " + blocked
                results.append(item)
                continue
            try:
                local = roadmap(cli, machine, local_project)
                local_plan = plan_named(local, plan["id"])
                if not same_campaign(plan, local_plan):
                    raise FleetError("Target campaign differs; not yet synchronized. Reread before launch.")
                local_step = step_named(local_plan, player["step"]["id"])
                if player["gui"] and "computer-use" in machine.get("capabilities", []):
                    computer_free(computer_state(cli, machine))
                check_runs(cli, machine, local_project, accepted_ids, item["runChecks"], "before-dispatch")
                if cli.confirmed:
                    item["status"] = "unknown"  # A timed-out write may still have been accepted.
                accepted = work(cli, machine, local_project, local, local_plan, local_step,
                                player["instructions"], player["requestId"])
                item["work"] = accepted
                if cli.confirmed:
                    if not isinstance(accepted, dict):
                        raise FleetError("Launch response is unknown. Do not retry or authorize Computer Use.")
                    if accepted.get("accepted") is True:
                        item["status"] = "accepted"
                    item["run"] = accepted.get("run")
                    if (accepted.get("accepted") is not True or not isinstance(item["run"], dict)
                            or any(item["run"].get(k) != value for k, value in
                                   (("projectId", local_project["id"]), ("machineId", machine["machineId"])))
                            or not isinstance(item["run"].get("id"), str) or not item["run"]["id"]):
                        raise FleetError("Accepted run identity does not match the launch target. Do not authorize Computer Use.")
                    accepted_ids.add(accepted["run"]["id"])
                    check_runs(cli, machine, local_project, accepted_ids, item["runChecks"], "after-acceptance")
                    if player["gui"] and "computer-use" in machine.get("capabilities", []):
                        state = computer_state(cli, machine)
                        computer_free(state)
                        if state["supported"]:
                            item["computerUseOwnershipCheck"] = {"status": "unavailable", "phase": "after-grant"}
                            item["computerUse"] = cli.write(machine["alias"], "/computer-use", {
                                "enabled": True, "expectedRevision": state["revision"],
                                "runId": accepted["run"]["id"]})
                            state = computer_state(cli, machine)
                            owner = state["owner"] or {}
                            verified = (state["supported"] and state["enabled"] and not state["ownerHidden"]
                                        and not state["cleanupPending"] and not state["cleanupFailed"]
                                        and owner.get("projectId") == local_project["id"]
                                        and owner.get("runId") == accepted["run"]["id"])
                            item["computerUseOwnershipCheck"] = {
                                "status": "verified" if verified else "blocked", "phase": "after-grant",
                                "state": state}
                            if not verified:
                                raise FleetError("Computer Use owner changed or is uncertain after grant. Never take over; manual review required.")
                            check_runs(cli, machine, local_project, accepted_ids, item["runChecks"], "after-grant")
                        else:
                            item["computerUseOwnershipCheck"] = {"status": "unsupported"}
                else:
                    item["status"] = "planned"
                    item["runChecks"].append({"phase": "after-acceptance", "status": "unavailable-until-confirmation"})
                    if player["gui"]:
                        item["computerUse"] = "After acceptance: check project runs and ownership, authorize only this run, then verify ownership."
                        item["computerUseOwnershipCheck"] = {"status": "unavailable-until-confirmation", "phase": "after-grant"}
            except (FleetError, KeyError) as exc:
                # Keep accepted run/request identity; do not retry, revoke, or dispatch this PC's next player.
                item["error"] = str(exc)
                blocked = str(exc)
                warnings.append(machine["alias"] + ": " + str(exc))
            results.append(item)
        return results

    # Independent PCs can dispatch in parallel; same-PC players stay ordered.
    with ThreadPoolExecutor(max_workers=len(groups)) as pool:
        results = [item for batch in pool.map(dispatch, groups.values()) for item in batch]
    return {"campaignId": campaign_id, "planId": plan["id"], "dryRun": not cli.confirmed,
            "preflight": preflight, "warnings": warnings, "sync": sync_results, "players": results}


def main():
    parser = argparse.ArgumentParser(description="Launch a Roadmap multiplayer campaign. Dry-run by default.")
    parser.add_argument("--machine", required=True, help="Source Roadmap machine")
    parser.add_argument("--project", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--campaign-id", help="12 hex characters; generated if omitted")
    parser.add_argument("--output", type=Path, help="Save launch manifest (must not exist)")
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("--output already exists; do not overwrite a launch manifest")
    cli = CLI(args.confirmed)
    machines = inventory(cli)
    source = machine_named(machines, args.machine)
    project = project_named(cli, source, args.project)
    plan = plan_named(roadmap(cli, source, project), args.plan)
    result = launch(cli, machines, source, project, plan, args.campaign_id or uuid.uuid4().hex[:12])
    output(result)  # Keep accepted run IDs even if the optional manifest cannot be saved.
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as file:
            json.dump(result, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    run_main(main)
