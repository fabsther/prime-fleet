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
                    same_step, work, computer_free, output, run_main)


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
            "Computer Use : attendre au plus 2 minutes si nécessaire, puis signaler et arrêter. "
            "Ne jamais l'activer soi-même.")
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


def launch(cli, machines, source, project, plan, campaign_id):
    players = players_for(plan, machines, campaign_id)
    groups = {}
    warnings = []
    for player in players:
        machine = player["machine"]
        groups.setdefault(machine["machineId"], []).append(player)
        if player["gui"]:
            if "computer-use" not in machine.get("capabilities", []):
                warnings.append(f"{machine['name']}: no computer-use capability. Enable locally if possible; player stops after 2 minutes.")
            else:
                state = cli.get(machine["alias"], "/computer-use")
                computer_free(state)
                if not state["supported"]:
                    warnings.append(f"{machine['name']}: Computer Use unsupported; manual setup needed.")
    # Validate project copies before any sync or launch mutations.
    copies = {key: project_copy(cli, group[0]["machine"], project) for key, group in groups.items()}
    sync_results = []
    result = sync(cli, source, project)
    if result:
        sync_results.append(result)

    def dispatch(group):
        machine = group[0]["machine"]
        local_project = copies[machine["machineId"]]
        results = []
        try:
            if machine["machineId"] != source["machineId"]:
                result = sync(cli, machine, local_project)
                if result:
                    results.append({"sync": result, "machine": machine["alias"]})
        except FleetError as exc:
            return [{"machine": machine["alias"], "stepId": p["step"]["id"],
                     "number": p["number"], "gui": p["gui"], "error": str(exc)} for p in group]
        # Sequential on this PC. Each acceptance can change the Roadmap revision.
        for player in group:
            item = {"machine": machine["alias"], "projectId": local_project["id"],
                    "stepId": player["step"]["id"], "number": player["number"],
                    "gui": player["gui"], "requestId": player["requestId"],
                    "computerUseCapability": "computer-use" in machine.get("capabilities", [])}
            try:
                local = roadmap(cli, machine, local_project)
                local_plan = plan_named(local, plan["id"])
                if not same_campaign(plan, local_plan):
                    raise FleetError("Target campaign differs; not yet synchronized. Reread before launch.")
                local_step = step_named(local_plan, player["step"]["id"])
                if player["gui"] and "computer-use" in machine.get("capabilities", []):
                    computer_free(cli.get(machine["alias"], "/computer-use"))
                accepted = work(cli, machine, local_project, local, local_plan, local_step,
                                player["instructions"], player["requestId"])
                item["work"] = accepted
                if cli.confirmed:
                    item["run"] = accepted["run"]
                    if accepted.get("accepted") is not True or any(
                            accepted["run"].get(k) != value for k, value in
                            (("projectId", local_project["id"]), ("machineId", machine["machineId"]))):
                        raise FleetError("Accepted run identity does not match the launch target. Do not authorize Computer Use.")
                    if player["gui"] and "computer-use" in machine.get("capabilities", []):
                        state = cli.get(machine["alias"], "/computer-use")
                        computer_free(state)
                        if state["supported"]:
                            item["computerUse"] = cli.write(machine["alias"], "/computer-use", {
                                "enabled": True, "expectedRevision": state["revision"],
                                "runId": accepted["run"]["id"]})
                elif player["gui"]:
                    item["computerUse"] = "After acceptance: reread ownership, then authorize only this run."
            except (FleetError, KeyError) as exc:
                # Retain an accepted run even if authorization fails. Other players continue.
                item["error"] = str(exc)
            results.append(item)
        return results

    # Independent PCs can dispatch in parallel; same-PC players stay ordered.
    with ThreadPoolExecutor(max_workers=len(groups)) as pool:
        results = [item for batch in pool.map(dispatch, groups.values()) for item in batch]
    return {"campaignId": campaign_id, "planId": plan["id"], "dryRun": not cli.confirmed,
            "warnings": warnings, "sync": sync_results, "players": results}


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
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as file:
            json.dump(result, file, ensure_ascii=False, indent=2)
    output(result)


if __name__ == "__main__":
    run_main(main)
