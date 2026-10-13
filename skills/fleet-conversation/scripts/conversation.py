import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import argparse
from _fleet import (CLI, FleetError, inventory, machine_named, project_named, project_copy,
                    project_path, path_id, request_id, sync, session_runs, last_message,
                    output, run_main)


def main():
    parser = argparse.ArgumentParser(description="Continue a synchronized conversation, or message its live run.")
    parser.add_argument("action", choices=["continue", "send"])
    parser.add_argument("--source", required=True, help="Machine with the latest history")
    parser.add_argument("--target", help="Machine to continue on")
    parser.add_argument("--project", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--mode", choices=["steer", "follow_up"], default="follow_up")
    parser.add_argument("--stop-active", action="store_true", help="Request stop, then exit; continue on a later invocation")
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    if not args.message or len(args.message) > 200000:
        parser.error("message must contain 1..200000 characters")
    cli = CLI(args.confirmed)
    machines = inventory(cli)
    if any(m["state"] != "online" for m in machines):
        raise FleetError("Cannot certify the conversation idle: a Fleet machine is unreadable. Resolve it before transfer or live messaging.")
    source = machine_named(machines, args.source)
    project = project_named(cli, source, args.project)
    running = session_runs(cli, machines, args.session)
    if args.action == "send":
        if len(running) != 1:
            raise FleetError("Expected exactly one live run for this conversation.")
        owner, run = running[0]
        owner_project = project_copy(cli, owner, project)
        if run["projectId"] != owner_project["id"]:
            raise FleetError("Live run belongs to another project.")
        output(cli.write(owner["alias"], "/sessions/" + path_id(args.session) + "/messages", {
            "requestId": request_id(), "mode": args.mode, "message": args.message}))
        return
    if not args.target:
        parser.error("continue requires --target")
    target = machine_named(machines, args.target)
    target_project = project_copy(cli, target, project)
    if running:
        if not args.stop_active:
            raise FleetError("Conversation has a live run. Wait, send to its owner, or explicitly stop it first.")
        if len(running) != 1:
            raise FleetError("Multiple live copies detected. Resolve them manually.")
        owner, run = running[0]
        owner_project = project_copy(cli, owner, project)
        if run["projectId"] != owner_project["id"]:
            raise FleetError("Live run belongs to another project.")
        output({"stop": cli.write(owner["alias"], "/runs/" + path_id(run["id"]) + "/stop", {}),
                "next": "Wait for run completion; invoke continue again. No automatic continuation."})
        return
    previews = []
    if source["machineId"] != target["machineId"]:
        for machine, local_project in ((source, project), (target, target_project)):
            result = sync(cli, machine, local_project, args.session)
            if result:
                previews.append(result)
    # Also verify after supported sync: its state enum is not part of v1-4.
    if last_message(cli, source, project, args.session) != last_message(cli, target, target_project, args.session):
        raise FleetError("Not yet synchronized on the target: last messages differ.")
    if session_runs(cli, machines, args.session):
        raise FleetError("A live run appeared during verification. Reread; do not launch.")
    result = cli.write(target["alias"], project_path(target_project) + "/runs", {
        "requestId": request_id(), "sessionId": args.session, "message": args.message})
    output({"sync": previews, "run": result})


if __name__ == "__main__":
    run_main(main)
