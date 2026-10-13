import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import argparse
from _fleet import (CLI, FleetError, inventory, machine_named, project_named, project_copy,
                    project_path, roadmap, plan_named, step_named, assignment, assign_note,
                    same_step, sync, work, output, run_main)


def main():
    parser = argparse.ArgumentParser(description="Assign or launch one Roadmap step. Dry-run by default.")
    parser.add_argument("action", choices=["assign", "launch"])
    parser.add_argument("--machine", required=True, help="Machine holding the source Roadmap")
    parser.add_argument("--project", required=True, help="Project ID, syncId or exact name")
    parser.add_argument("--plan", required=True, help="Plan ID or exact title")
    parser.add_argument("--step", required=True, help="Stable step ID")
    parser.add_argument("--assign", help="New machine (assign only)")
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    cli = CLI(args.confirmed)
    machines = inventory(cli)
    source = machine_named(machines, args.machine)
    project = project_named(cli, source, args.project)
    doc = roadmap(cli, source, project)
    plan = plan_named(doc, args.plan)
    step = step_named(plan, args.step)
    if args.action == "assign":
        if not args.assign:
            parser.error("assign requires --assign")
        target = machine_named(machines, args.assign)
        note = assign_note(step.get("note", ""), target["name"])
        if len(note) > 16000:
            raise FleetError("Step note exceeds 16000 characters.")
        output(cli.write(source["alias"], project_path(project) + "/roadmap/mutations", {
            "action": "step.edit", "expectedRevision": doc["revision"],
            "planId": plan["id"], "stepId": step["id"], "note": note}))
        return
    if args.assign:
        parser.error("--assign applies only to assign")
    target = machine_named(machines, assignment(step))
    target_project = project_copy(cli, target, project)
    previews = []
    if target["machineId"] != source["machineId"]:
        for machine, local_project in ((source, project), (target, target_project)):
            result = sync(cli, machine, local_project)
            if result:
                previews.append(result)
    # Target copy, not source revision: a sync or prior work may change it.
    local = roadmap(cli, target, target_project)
    local_plan = plan_named(local, plan["id"])
    local_step = step_named(local_plan, step["id"])
    if not same_step(step, local_step):
        raise FleetError("Target step differs; not yet synchronized. Reread before launching.")
    result = work(cli, target, target_project, local, local_plan, local_step)
    output({"sync": previews, "work": result})


if __name__ == "__main__":
    run_main(main)
