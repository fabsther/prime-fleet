"""Small shared helpers. All Studio traffic goes through the desktop CLI."""
import json
import re
import subprocess
import uuid
from urllib.parse import quote


class FleetError(RuntimeError):
    pass


def output(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


class CLI:
    def __init__(self, confirmed=False):
        self.confirmed = confirmed

    def command(self, *args):
        try:
            result = subprocess.run(["prime-fleet", *args], capture_output=True,
                                    text=True, encoding="utf-8", timeout=120)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise FleetError("CLI unavailable or timed out; outcome may be unknown. Do not retry automatically.") from exc
        if result.returncode:
            # Do not print raw CLI stderr: it may contain secret server diagnostics.
            raise FleetError("CLI request failed. Reread state after a conflict or timeout; no automatic retry.")
        try:
            return json.loads(result.stdout)
        except ValueError as exc:
            raise FleetError("CLI did not return JSON; outcome may be unknown.") from exc

    def get(self, machine, path):
        return self.command("api", machine, "GET", "/api/v1" + path)

    def write(self, machine, path, body):
        if not self.confirmed:
            return {"dryRun": True, "machine": machine, "method": "POST",
                    "path": "/api/v1" + path, "body": body}
        return self.command("api", machine, "POST", "/api/v1" + path,
                            json.dumps(body, ensure_ascii=False))

    def pages(self, machine, path):
        items, offset = [], 0
        while True:
            page = self.get(machine, f"{path}?limit=200&offset={offset}")
            items.extend(page["items"])
            nxt = page.get("nextOffset")
            if nxt is None:
                return items
            if type(nxt) is not int or nxt <= offset:
                raise FleetError("Invalid pagination cursor.")
            offset = nxt


def path_id(value):
    return quote(str(value), safe="")


def request_id():
    return uuid.uuid4().hex


def inventory(cli):
    configured = cli.command("machines")
    if isinstance(configured, dict):
        configured = configured["machines"]
    result = []
    for item in configured:
        alias = item["name"]
        try:
            info = cli.get(alias, "/machine")
            result.append({**info, "alias": alias, "state": "online"})
        except FleetError as exc:
            result.append({"alias": alias, "name": alias, "state": "error", "error": str(exc)})
    return result


def machine_named(machines, name):
    matches = [m for m in machines if name.casefold() in
               {str(m.get(k, "")).casefold() for k in ("alias", "name", "machineId")}]
    if len(matches) != 1 or matches[0]["state"] != "online":
        raise FleetError(f"Machine {name!r} is unknown, ambiguous or offline.")
    return matches[0]


def project_named(cli, machine, selector):
    projects = cli.pages(machine["alias"], "/projects")
    matches = [p for p in projects if selector in (p["id"], p["name"], p.get("syncId"))]
    if len(matches) != 1 or not matches[0].get("exists", False):
        raise FleetError("Project is absent or ambiguous on " + machine["name"])
    return matches[0]


def project_copy(cli, machine, source):
    key = source.get("syncId") or source["name"]
    projects = cli.pages(machine["alias"], "/projects")
    matches = [p for p in projects if (p.get("syncId") == key if source.get("syncId") else p["name"] == key)]
    if len(matches) != 1 or not matches[0].get("exists", False):
        raise FleetError("Project copy is absent or ambiguous on " + machine["name"])
    return matches[0]


def project_path(project):
    return "/projects/" + path_id(project["id"])


def sync(cli, machine, project, session_id=None):
    if "sync" not in machine.get("capabilities", []):
        return None
    # Proposed extension: never probe it on older servers or assume a state enum.
    return cli.write(machine["alias"], project_path(project) + "/sync",
                     {"sessionId": session_id} if session_id else {})


def roadmap(cli, machine, project):
    return cli.get(machine["alias"], project_path(project) + "/roadmap")["roadmap"]


def plan_named(doc, selector):
    matches = [p for p in doc.get("plans", []) if selector in (p["id"], p.get("title"))]
    if len(matches) != 1:
        raise FleetError("Plan absent or ambiguous; use its stable ID.")
    return matches[0]


def steps(plan):
    def walk(items):
        for step in items:
            yield step
            yield from walk(step.get("children", []))
    return list(walk(plan.get("steps", [])))


def step_named(plan, step_id):
    matches = [s for s in steps(plan) if s["id"] == step_id]
    if len(matches) != 1:
        raise FleetError("Step not yet synchronized or absent.")
    return matches[0]


def directive(note, tag):
    return re.findall(r"^[ \t]*@" + re.escape(tag) + r":[ \t]*([^\r\n]*?)[ \t]*\r?$", note, re.I | re.M)


def marker(text, tag):
    return bool(re.search(r"^[ \t]*@" + re.escape(tag) + r"[ \t]*\r?$", text, re.I | re.M))


def assignment(step):
    names = directive(step.get("note", ""), "machine")
    if len(names) != 1 or not names[0]:
        raise FleetError("Each step needs exactly one standalone @machine: directive.")
    return names[0]


def assign_note(note, name):
    if not name.strip() or "\n" in name or "\r" in name:
        raise FleetError("Machine names must fit on one nonempty directive line.")
    lines = [line for line in note.splitlines() if not re.fullmatch(r"\s*@machine:.*", line, re.I)]
    return "\n".join(lines).rstrip() + ("\n" if lines else "") + "@machine: " + name


def same_step(a, b):
    return all(a.get(k) == b.get(k) for k in ("id", "text", "note", "done"))


def work(cli, machine, project, doc, plan, step, instructions="", rid=None):
    if step.get("done"):
        raise FleetError("Refusing to launch a checked step.")
    if len(instructions) > 4000:
        raise FleetError("Instructions exceed 4000 characters.")
    return cli.write(machine["alias"], project_path(project) + "/roadmap/work", {
        "requestId": rid or request_id(), "expectedRevision": doc["revision"],
        "targets": [{"kind": "plan", "planId": plan["id"], "stepId": step["id"]}],
        "instructions": instructions})


def active(run):
    # Status is an open string in v1. Unknown statuses are active (fail closed).
    return not run.get("endedAt") and str(run.get("status", "")).lower() not in {
        "done", "completed", "finished", "failed", "stopped", "cancelled", "canceled", "error"}


def session_runs(cli, machines, session_id):
    return [(machine, run) for machine in machines if machine["state"] == "online"
            for run in cli.pages(machine["alias"], "/runs")
            if run.get("sessionId") == session_id and active(run)]


def last_message(cli, machine, project, session_id):
    sessions = cli.pages(machine["alias"], project_path(project) + "/sessions")
    if not any(s["id"] == session_id for s in sessions):
        raise FleetError("Conversation not yet synchronized on " + machine["name"])
    items = cli.pages(machine["alias"], "/sessions/" + path_id(session_id) + "/messages")
    return items[-1] if items else None


def computer_free(state):
    if state.get("owner") or state.get("ownerHidden") or state.get("enabled") or state.get("busy"):
        raise FleetError("Computer Use has another owner or is busy. Never take it over.")
    if state.get("cleanupPending") or state.get("cleanupFailed"):
        raise FleetError("Computer Use cleanup is uncertain. Manual intervention required.")


def owns(state, run):
    owner = state.get("owner") or {}
    if state.get("ownerHidden") or owner.get("projectId") != run["projectId"]:
        return False
    if owner.get("runId") is not None:
        return owner["runId"] == run["id"]
    return run.get("sessionId") is not None and owner.get("sessionId") == run["sessionId"]


def run_main(main):
    try:
        main()
    except (FleetError, KeyError, ValueError) as exc:
        output({"error": str(exc), "retry": "Never retry an ambiguous write automatically; reread first."})
        raise SystemExit(1)
