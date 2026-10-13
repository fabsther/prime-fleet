"""Offline stdlib checks: fake the CLI, never the safety guard."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs

SKILLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILLS))
import _fleet as fleet


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, SKILLS / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


machines_script = load("machines_script", "fleet-machines/scripts/machines.py")
roadmap_script = load("roadmap_script", "fleet-roadmap/scripts/roadmap.py")
conversation_script = load("conversation_script", "fleet-conversation/scripts/conversation.py")
campaign = load("launch_campaign", "multiplayer-testing/scripts/launch_campaign.py")
control = load("campaign_control", "multiplayer-testing/scripts/campaign.py")


class FakeCLI(fleet.CLI):
    def __init__(self, confirmed=False):
        super().__init__(confirmed)
        self.calls, self.runs = [], {}
        self.plan = {"id": "P", "title": "Campaign", "summary": "@CAMPAIGN\nCommit: abc; host A UDP 7777.", "steps": [
            {"id": "a", "text": "Host", "note": "@machine: A\n@gui\n1. Host: HUD shows listening.", "done": False},
            {"id": "b", "text": "Guest", "note": "@machine: B\n@gui\n1. Join: HUD shows host.", "done": False}]}
        self.docs = {m: {"revision": 1, "plans": [copy.deepcopy(self.plan)]} for m in ("A", "B")}
        self.info = {m: {"name": m, "machineId": m, "capabilities": ["computer-use"]} for m in ("A", "B")}
        self.cu = {m: {"revision": 1, "supported": True, "enabled": False, "busy": False,
                       "owner": None, "ownerHidden": False, "cleanupPending": False,
                       "cleanupFailed": False} for m in ("A", "B")}
        self.messages = {m: [{"id": "msg", "role": "assistant", "text": "Done"}] for m in ("A", "B")}
        self.fail_work = set()
        self.steal_after_work = False
        self.before_runs = None
        self.after_work = None
        self.after_grant = None
        self.after_sync = None

    def command(self, *args):
        self.calls.append(args)
        if args == ("machines",):
            return [{"id": m, "name": m, "url": "https://example.invalid"} for m in ("A", "B")]
        _, machine, method, full_path, *payload = args
        parsed = urlsplit(full_path)
        path = parsed.path.removeprefix("/api/v1")
        if method == "GET":
            if path == "/machine":
                value = self.info[machine]
            elif path == "/computer-use":
                value = copy.deepcopy(self.cu[machine])
                if self.steal_after_work and self.runs:
                    value["ownerHidden"] = True
            elif path.endswith("/roadmap"):
                value = {"machineId": machine, "projectId": "P" + machine, "roadmap": self.docs[machine]}
            elif path.startswith("/runs/"):
                value = self.runs[path.rsplit("/", 1)[-1]]
            else:
                if path == "/projects":
                    items = [{"id": "P" + machine, "name": "Game", "syncId": "S", "exists": True}]
                elif path.endswith("/sessions"):
                    items = [{"id": "S1", "projectId": "P" + machine}]
                elif path.endswith("/messages"):
                    items = self.messages[machine]
                elif path == "/runs":
                    if self.before_runs:
                        self.before_runs(machine)
                    items = [r for r in self.runs.values() if r["machineId"] == machine]
                elif path.endswith("/files"):
                    items = []
                else:
                    raise AssertionError(path)
                offset = int(parse_qs(parsed.query).get("offset", ["0"])[0])
                value = {"items": items[offset:offset + 200],
                         "nextOffset": offset + 200 if len(items) > offset + 200 else None}
            return copy.deepcopy(value)
        body = json.loads(payload[0])
        if path.endswith("/sync"):
            if self.after_sync:
                self.after_sync(machine)
            return {"state": "unspecified", "changed": False}
        if path.endswith("/roadmap/mutations"):
            doc = self.docs[machine]
            assert body["expectedRevision"] == doc["revision"]
            fleet.step_named(doc["plans"][0], body["stepId"])["note"] = body["note"]
            doc["revision"] += 1
            return {"roadmap": copy.deepcopy(doc)}
        if path.endswith("/roadmap/work") or path.endswith("/runs"):
            if machine in self.fail_work:
                raise fleet.FleetError("Ambiguous write failure")
            if "expectedRevision" in body:
                assert body["expectedRevision"] == self.docs[machine]["revision"]
                self.docs[machine]["revision"] += 1
            rid = "r" + str(len(self.runs) + 1)
            run = {"id": rid, "sessionId": "s" + rid, "projectId": "P" + machine,
                   "machineId": machine, "status": "running"}
            self.runs[rid] = run
            if self.after_work:
                self.after_work(machine, run)
            return {"accepted": True, "run": copy.deepcopy(run)} if path.endswith("/work") else copy.deepcopy(run)
        if path == "/computer-use":
            assert body["expectedRevision"] == self.cu[machine]["revision"]
            if body["enabled"]:
                run = self.runs[body["runId"]]
                self.cu[machine]["owner"] = {"projectId": run["projectId"], "runId": run["id"], "sessionId": run["sessionId"]}
            else:
                self.cu[machine]["owner"] = None
            self.cu[machine]["enabled"] = body["enabled"]
            self.cu[machine]["revision"] += 1
            response = copy.deepcopy(self.cu[machine])
            if body["enabled"] and self.after_grant:
                self.after_grant(machine, run)
            return response
        if path.endswith("/stop"):
            assert body == {}
            self.runs[path.split("/")[2]].update(status="stopped", endedAt="now")
            return {"stopped": True}
        if path.endswith("/messages"):
            return {"accepted": True}
        raise AssertionError(path)

    def posts(self):
        return [call for call in self.calls if len(call) > 2 and call[2] == "POST"]


def launch(fake):
    machines = fleet.inventory(fake)
    source = fleet.machine_named(machines, "A")
    project = fleet.project_named(fake, source, "Game")
    return campaign.launch(fake, machines, source, project, copy.deepcopy(fake.plan), "a1b2c3d4e5f6")


def run_main(module, fake, args):
    with patch.object(module, "CLI", return_value=fake), patch.object(sys, "argv", ["script", *args]), contextlib.redirect_stdout(io.StringIO()) as stream:
        module.main()
    return json.loads(stream.getvalue())


def same_pc(fake, gui=False):
    for index, step in enumerate(fake.plan["steps"]):
        step["note"] = "@machine: A" + ("\n@gui" if gui and index == 0 else "")
    fake.docs["A"]["plans"] = [copy.deepcopy(fake.plan)]


def other_run(fake, machine="A", project=None, status="running", rid="old", session="old-session"):
    fake.runs[rid] = {"id": rid, "machineId": machine, "projectId": project or "P" + machine,
                      "status": status, "sessionId": session}


class SafetyTests(unittest.TestCase):
    def test_all_skill_entrypoints_dry_run(self):
        fake = FakeCLI()
        for info in fake.info.values():
            info["capabilities"].append("sync")
        run_main(machines_script, fake, [])
        assigned = run_main(roadmap_script, fake, ["assign", "--machine", "A", "--project", "Game", "--plan", "P", "--step", "a", "--assign", "B"])
        self.assertTrue(assigned["dryRun"])
        run_main(roadmap_script, fake, ["launch", "--machine", "A", "--project", "Game", "--plan", "P", "--step", "b"])
        run_main(conversation_script, fake, ["continue", "--source", "A", "--target", "B", "--project", "Game", "--session", "S1", "--message", "Continue"])
        result = run_main(campaign, fake, ["--machine", "A", "--project", "Game", "--plan", "P"])
        self.assertTrue(result["dryRun"])
        self.assertEqual(fake.posts(), [])
        self.assertEqual(fake.runs, {})

    def test_assignment_preserves_text_and_is_case_insensitive(self):
        self.assertEqual(fleet.assign_note("first\n @MaChInE: A\nlast\n@machine: B", "C"), "first\nlast\n@machine: C")
        self.assertEqual(fleet.assignment({"note": "@MACHINE: A"}), "A")
        with self.assertRaises(fleet.FleetError):
            fleet.assignment({"note": "@machine: A\n@machine: B"})
        with self.assertRaises(fleet.FleetError):
            fleet.assignment({"note": "@machine:\nA"})
        self.assertEqual(fleet.assignment({"note": "@machine: A\r\n@gui"}), "A")

    def test_campaign_validation_before_mutations(self):
        for change in ("unknown", "too_many", "duplicate_gui", "too_long", "collision"):
            fake = FakeCLI(True)
            if change == "unknown":
                fake.plan["steps"][0]["note"] = "@machine: UNKNOWN"
            elif change == "too_many":
                fake.plan["steps"] *= 5
            elif change == "duplicate_gui":
                fake.plan["steps"][1]["note"] = "@machine: A\n@gui"
            elif change == "too_long":
                fake.plan["summary"] += "x" * 4000
            else:
                fake.plan["steps"][0]["id"] = "x" * 100 + "a"
                fake.plan["steps"][1]["id"] = "x" * 100 + "b"
            with self.subTest(change=change), self.assertRaises(fleet.FleetError):
                launch(fake)
            self.assertEqual(fake.posts(), [])

    def test_owner_hidden_busy_or_cleanup_blocks_preflight(self):
        for key, value in (("ownerHidden", True), ("owner", {"projectId": "other"}), ("busy", True), ("cleanupFailed", True)):
            fake = FakeCLI(True)
            fake.cu["A"][key] = value
            with self.subTest(key=key), self.assertRaises(fleet.FleetError):
                launch(fake)
            self.assertEqual(fake.posts(), [])

    def test_gui_owner_race_retains_accepted_run_without_takeover(self):
        fake = FakeCLI(True)
        fake.steal_after_work = True
        result = launch(fake)
        accepted = [p for p in result["players"] if p.get("run")]
        self.assertTrue(accepted)
        self.assertTrue(any(p.get("error") for p in accepted))
        self.assertFalse(any(c[3].endswith("/computer-use") for c in fake.posts()))

    def test_same_pc_revision_reread_and_request_id_header(self):
        fake = FakeCLI(True)
        for step in fake.plan["steps"]:
            step["note"] = "@machine: A\n1. Run: observable HUD."
        fake.docs["A"]["plans"] = [copy.deepcopy(fake.plan)]
        result = launch(fake)
        self.assertFalse(any(p.get("error") for p in result["players"]))
        bodies = [json.loads(c[4]) for c in fake.posts() if c[3].endswith("/work")]
        self.assertEqual([b["expectedRevision"] for b in bodies], [1, 2])
        self.assertEqual(set(bodies[0]), {"requestId", "expectedRevision", "targets", "instructions"})
        self.assertEqual(bodies[0]["targets"], [{"kind": "plan", "planId": "P", "stepId": "a"}])
        self.assertEqual([b["requestId"] for b in bodies], ["cmp_a1b2c3d4e5f6_a", "cmp_a1b2c3d4e5f6_b"])
        self.assertIn("joueur 1/2", bodies[0]["instructions"])
        self.assertIn("player-2.md", bodies[1]["instructions"])
        self.assertTrue(all(len(b["instructions"]) <= 4000 for b in bodies))

    def test_ambiguous_failure_not_retried_and_other_machine_runs(self):
        fake = FakeCLI(True)
        fake.fail_work.add("A")
        result = launch(fake)
        self.assertEqual(sum(c[1] == "A" and c[3].endswith("/work") for c in fake.posts()), 1)
        self.assertTrue(any(p.get("run") and p["machine"] == "B" for p in result["players"]))

    def test_sync_only_when_advertised(self):
        fake = FakeCLI(True)
        launch(fake)
        self.assertFalse(any(c[3].endswith("/sync") for c in fake.posts()))
        fake = FakeCLI(True)
        fake.info["B"]["capabilities"].append("sync")
        launch(fake)
        sync_calls = [c for c in fake.posts() if c[3].endswith("/sync")]
        self.assertEqual([c[1] for c in sync_calls], ["B"])

    def test_target_changed_blocks_its_launch(self):
        fake = FakeCLI(True)
        fake.docs["B"]["plans"][0]["steps"][1]["text"] = "Changed"
        result = launch(fake)
        self.assertTrue(any(p.get("error") and p["machine"] == "B" for p in result["players"]))
        self.assertFalse(any(c[1] == "B" and c[3].endswith("/work") for c in fake.posts()))

    def test_conversation_difference_pagination_and_live_owner(self):
        fake = FakeCLI(True)
        fake.messages["A"] *= 205
        fake.messages["B"] = copy.deepcopy(fake.messages["A"])
        fake.messages["B"][-1]["text"] = "Different"
        args = ["continue", "--source", "A", "--target", "B", "--project", "Game", "--session", "S1", "--message", "Continue"]
        with self.assertRaises(fleet.FleetError):
            run_main(conversation_script, fake, args)
        self.assertEqual(fake.posts(), [])
        self.assertTrue(any("offset=200" in c[3] for c in fake.calls if len(c) > 3))
        fake.runs["r1"] = {"id": "r1", "machineId": "B", "projectId": "PB", "sessionId": "S1", "status": "running"}
        with self.assertRaises(fleet.FleetError):
            run_main(conversation_script, fake, args)
        run_main(conversation_script, fake, ["send", "--source", "A", "--project", "Game", "--session", "S1", "--message", "Update"])
        self.assertEqual(fake.posts()[-1][1], "B")
        self.assertTrue(fake.posts()[-1][3].endswith("/messages"))

    def test_stop_all_before_revoke_and_never_other_owner(self):
        fake = FakeCLI(True)
        manifest = launch(fake)
        fake.calls.clear()
        control.control(fake, manifest, "stop")
        posts = fake.posts()
        self.assertEqual([c[3].rsplit("/", 1)[-1] for c in posts], ["stop", "stop", "computer-use", "computer-use"])
        self.assertTrue(all(json.loads(c[4]) == {} for c in posts[:2]))
        self.assertTrue(all(set(json.loads(c[4])) == {"enabled", "expectedRevision", "sessionId"} for c in posts[2:]))
        fake.cu["A"]["owner"] = {"projectId": "unrelated", "sessionId": "other"}
        fake.calls.clear()
        control.control(fake, manifest, "stop")
        self.assertFalse(any(c[1] == "A" and c[3].endswith("/computer-use") for c in fake.posts()))

    def test_unreadable_fleet_member_blocks_transfer(self):
        fake = FakeCLI(True)
        real_command = fake.command
        def command(*args):
            if args == ("api", "B", "GET", "/api/v1/machine"):
                raise fleet.FleetError("Unreadable")
            return real_command(*args)
        fake.command = command
        with self.assertRaises(fleet.FleetError):
            run_main(conversation_script, fake, ["continue", "--source", "A", "--target", "B", "--project", "Game", "--session", "S1", "--message", "Continue"])
        self.assertEqual(fake.posts(), [])

    def test_same_session_different_run_is_not_our_gui_owner(self):
        run = {"id": "old", "projectId": "P", "sessionId": "S"}
        state = {"owner": {"projectId": "P", "sessionId": "S", "runId": "new"}, "ownerHidden": False}
        self.assertFalse(fleet.owns(state, run))
        state["owner"].pop("runId")
        self.assertTrue(fleet.owns(state, run))

    def test_stop_active_exits_without_launch(self):
        fake = FakeCLI()
        fake.runs["r1"] = {"id": "r1", "machineId": "A", "projectId": "PA", "sessionId": "S1", "status": "unknown_future_status"}
        result = run_main(conversation_script, fake, ["continue", "--source", "A", "--target", "B", "--project", "Game", "--session", "S1", "--message", "Continue", "--stop-active"])
        self.assertTrue(result["stop"]["dryRun"])
        self.assertEqual(fake.posts(), [])
        fake.confirmed = True
        run_main(conversation_script, fake, ["continue", "--source", "A", "--target", "B", "--project", "Game", "--session", "S1", "--message", "Continue", "--stop-active", "--confirmed"])
        self.assertEqual(len(fake.posts()), 1)
        self.assertTrue(fake.posts()[0][3].endswith("/stop"))

    def test_cli_failure_is_not_retried_or_logged(self):
        result = type("Process", (), {"returncode": 1, "stdout": "", "stderr": "pa_SECRET"})()
        with patch.object(fleet.subprocess, "run", return_value=result) as call:
            with self.assertRaises(fleet.FleetError) as error:
                fleet.CLI(True).write("A", "/projects/PA/runs", {"requestId": "x" * 32, "message": "Test"})
            self.assertEqual(call.call_count, 1)
            self.assertNotIn("pa_SECRET", str(error.exception))

    def test_manifest_reaches_stdout_when_optional_file_save_fails(self):
        fake = FakeCLI()
        manifest = {"campaignId": "abcdef012345", "players": [{"accepted": {"run": {"id": "kept-run"}}}]}
        stream = io.StringIO()
        with patch.object(campaign, "CLI", return_value=fake), patch.object(campaign, "launch", return_value=manifest), \
             patch.object(Path, "exists", return_value=False), patch.object(Path, "mkdir"), \
             patch.object(Path, "open", side_effect=OSError("Permission denied")), \
             patch.object(sys, "argv", ["launch", "--machine", "A", "--project", "Game", "--plan", "P", "--output", "manifest.json"]), \
             contextlib.redirect_stdout(stream):
            with self.assertRaises(OSError):
                campaign.main()
        self.assertEqual(json.loads(stream.getvalue()), manifest)

    def test_followup_dry_run_and_gui_missing_capability(self):
        fake = FakeCLI(True)
        fake.info["B"]["capabilities"] = []
        manifest = launch(fake)
        self.assertTrue(manifest["warnings"])
        self.assertFalse(any(c[1] == "B" and c[3] == "/api/v1/computer-use" for c in fake.calls if len(c) > 3))
        fake.confirmed = False
        fake.calls.clear()
        control.control(fake, manifest, "send", "Update")
        control.control(fake, manifest, "stop")
        self.assertEqual(fake.posts(), [])


    def test_preexisting_project_run_blocks_all_writes_including_sync(self):
        for gui in (False, True):
            fake = FakeCLI(True)
            for info in fake.info.values():
                info["capabilities"].append("sync")
            if not gui:
                for step in fake.plan["steps"]:
                    step["note"] = step["note"].replace("\n@gui", "")
            other_run(fake, "B")
            with self.subTest(gui=gui), self.assertRaisesRegex(fleet.FleetError, "Active same-project run"):
                launch(fake)
            self.assertEqual(fake.posts(), [])

    def test_project_run_preflight_reads_all_targets_before_first_write(self):
        fake = FakeCLI(True)
        fake.info["A"]["capabilities"].append("sync")
        launch(fake)
        first_post = next(i for i, c in enumerate(fake.calls) if len(c) > 2 and c[2] == "POST")
        inspected = {c[1] for c in fake.calls[:first_post] if len(c) > 3 and "/runs?" in c[3]}
        self.assertEqual(inspected, {"A", "B"})

    def test_cross_project_and_terminal_runs_are_ignored(self):
        fake = FakeCLI(True)
        other_run(fake, project="different")
        for index, status in enumerate(("completed", "failed", "stopped", "cancelled", "canceled", "DONE", "finished", "ERROR")):
            other_run(fake, status=status, rid="done" + str(index))
        other_run(fake, status="future-terminal", rid="ended")
        fake.runs["ended"]["endedAt"] = "now"
        result = launch(fake)
        self.assertFalse(any(p.get("error") for p in result["players"]))
        self.assertTrue(all(p["status"] == "accepted" for p in result["players"]))

    def test_unknown_active_status_blocks_and_runs_are_paginated(self):
        fake = FakeCLI(True)
        for index in range(205):
            other_run(fake, project="different", rid="other" + str(index))
        other_run(fake, status="unknown-future-status")
        with self.assertRaises(fleet.FleetError):
            launch(fake)
        self.assertEqual(fake.posts(), [])
        self.assertTrue(any("/runs?limit=200&offset=200" in c[3] for c in fake.calls if len(c) > 3))

    def test_fresh_project_run_after_preflight_blocks_dispatch(self):
        fake = FakeCLI(True)
        same_pc(fake, gui=True)
        reads = []
        def resume(machine):
            reads.append(machine)
            if len(reads) == 2:
                other_run(fake)
        fake.before_runs = resume
        result = launch(fake)
        self.assertEqual(fake.posts(), [])
        self.assertEqual([p["status"] for p in result["players"]], ["not-dispatched", "not-dispatched"])
        self.assertEqual(result["players"][0]["runChecks"][-1]["status"], "blocked")
        self.assertIn("group blocked", result["players"][1]["error"])

    def test_project_run_after_sync_blocks_dispatch(self):
        fake = FakeCLI(True)
        same_pc(fake)
        fake.info["A"]["capabilities"].append("sync")
        fake.after_sync = lambda machine: other_run(fake, machine)
        result = launch(fake)
        self.assertTrue(all(p.get("error") for p in result["players"]))
        self.assertEqual([c[3].rsplit("/", 1)[-1] for c in fake.posts()], ["sync"])

    def test_own_two_exact_accepted_run_ids_are_allowed(self):
        fake = FakeCLI(True)
        same_pc(fake, gui=True)
        result = launch(fake)
        self.assertFalse(any(p.get("error") for p in result["players"]))
        self.assertEqual(len({p["run"]["id"] for p in result["players"]}), 2)
        self.assertEqual(result["players"][0]["computerUseOwnershipCheck"]["status"], "verified")
        for player in result["players"]:
            self.assertTrue(all(c["status"] == "clear" for c in player["runChecks"]))

    def test_postacceptance_conflict_same_session_retains_identity_blocks_next(self):
        fake = FakeCLI(True)
        same_pc(fake, gui=True)
        fake.after_work = lambda machine, run: other_run(fake, machine, session=run["sessionId"])
        result = launch(fake)
        first, second = result["players"]
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(first["run"]["id"], first["work"]["run"]["id"])
        self.assertEqual(first["requestId"], "cmp_a1b2c3d4e5f6_a")
        self.assertEqual(first["runChecks"][-1]["phase"], "after-acceptance")
        self.assertEqual(first["runChecks"][-1]["conflictingRunIds"], ["old"])
        self.assertIn("Active same-project run", first["error"])
        self.assertEqual(second["status"], "not-dispatched")
        self.assertTrue(result["warnings"])
        self.assertEqual([c[3].rsplit("/", 1)[-1] for c in fake.posts()], ["work"])

    def test_owner_changes_after_grant_are_reported_without_takeover(self):
        for change in ("changed", "same-session-other-run", "hidden", "unknown", "disabled", "cleanup"):
            fake = FakeCLI(True)
            same_pc(fake, gui=True)
            def steal(machine, run):
                state = fake.cu[machine]
                if change == "changed":
                    state["owner"] = {"projectId": "other", "runId": "other"}
                elif change == "same-session-other-run":
                    state["owner"]["runId"] = "different"
                elif change == "hidden":
                    state["ownerHidden"] = True
                elif change == "unknown":
                    state.pop("ownerHidden")
                elif change == "disabled":
                    state["enabled"] = False
                else:
                    state["cleanupPending"] = True
            fake.after_grant = steal
            result = launch(fake)
            first, second = result["players"]
            with self.subTest(change=change):
                self.assertEqual(first["status"], "accepted")
                self.assertTrue(first["run"]["id"])
                self.assertIn("error", first)
                self.assertIn(first["computerUseOwnershipCheck"]["status"], {"blocked", "unavailable"})
                self.assertEqual(second["status"], "not-dispatched")
                self.assertEqual([c[3].rsplit("/", 1)[-1] for c in fake.posts()], ["work", "computer-use"])
                self.assertTrue(json.loads(fake.posts()[-1][4])["enabled"])

    def test_unknown_computer_state_blocks_preflight_without_writes(self):
        for field in ("owner", "ownerHidden", "enabled", "supported", "revision", "cleanupFailed"):
            fake = FakeCLI(True)
            fake.cu["A"].pop(field)
            with self.subTest(field=field), self.assertRaisesRegex(fleet.FleetError, "unknown"):
                launch(fake)
            self.assertEqual(fake.posts(), [])

        for owner in ({}, [], "unknown"):
            fake = FakeCLI(True)
            fake.cu["A"]["owner"] = owner
            with self.subTest(owner=owner), self.assertRaisesRegex(fleet.FleetError, "unknown"):
                launch(fake)
            self.assertEqual(fake.posts(), [])

    def test_healthy_postgrant_status_and_fresh_get(self):
        fake = FakeCLI(True)
        result = launch(fake)
        for player in result["players"]:
            check = player["computerUseOwnershipCheck"]
            self.assertEqual(check["status"], "verified")
            self.assertEqual(check["phase"], "after-grant")
            self.assertEqual(check["state"]["owner"]["runId"], player["run"]["id"])
            grant = next(i for i, c in enumerate(fake.calls) if len(c) > 3 and c[1] == player["machine"]
                         and c[2:4] == ("POST", "/api/v1/computer-use"))
            self.assertTrue(any(c == ("api", player["machine"], "GET", "/api/v1/computer-use") for c in fake.calls[grant + 1:]))

    def test_postgrant_project_run_conflict_preserves_run_without_revoke(self):
        fake = FakeCLI(True)
        same_pc(fake, gui=True)
        fake.after_grant = lambda machine, run: other_run(fake, machine)
        result = launch(fake)
        first, second = result["players"]
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(first["runChecks"][-1]["phase"], "after-grant")
        self.assertEqual(first["runChecks"][-1]["status"], "blocked")
        self.assertTrue(first["error"])
        self.assertEqual(second["status"], "not-dispatched")
        self.assertEqual([c[3].rsplit("/", 1)[-1] for c in fake.posts()], ["work", "computer-use"])

    def test_dry_run_exposes_unavailable_postdispatch_checks_and_stop_instruction(self):
        fake = FakeCLI()
        result = launch(fake)
        self.assertEqual(fake.posts(), [])
        self.assertTrue(all(c["status"] == "clear" for c in result["preflight"]))
        for player in result["players"]:
            self.assertEqual(player["status"], "planned")
            self.assertNotIn("run", player)
            self.assertEqual(player["runChecks"][-1]["status"], "unavailable-until-confirmation")
            self.assertEqual(player["computerUseOwnershipCheck"]["status"], "unavailable-until-confirmation")
            instructions = player["work"]["body"]["instructions"]
            self.assertIn("another agent session owns Computer Use OR a game instance already runs ON THIS MACHINE", instructions)
            self.assertIn("report and STOP without taking control", instructions)

    def test_unknown_run_identity_blocks_without_writes(self):
        for field in ("id", "projectId"):
            fake = FakeCLI(True)
            other_run(fake)
            fake.runs["old"].pop(field)
            with self.subTest(field=field), self.assertRaisesRegex(fleet.FleetError, "identity is unknown"):
                launch(fake)
            self.assertEqual(fake.posts(), [])

    def test_unreadable_runs_blocks_all_writes(self):
        fake = FakeCLI(True)
        fake.info["A"]["capabilities"].append("sync")
        def fail(machine):
            if machine == "B":
                raise fleet.FleetError("Run list unavailable")
        fake.before_runs = fail
        with self.assertRaisesRegex(fleet.FleetError, "unavailable"):
            launch(fake)
        self.assertEqual(fake.posts(), [])

    def test_unreadable_postgrant_preserves_run_and_blocks_next(self):
        fake = FakeCLI(True)
        same_pc(fake, gui=True)
        real_command = fake.command
        def command(*args):
            if args == ("api", "A", "GET", "/api/v1/computer-use") and fake.cu["A"]["enabled"]:
                raise fleet.FleetError("Ownership unavailable")
            return real_command(*args)
        fake.command = command
        first, second = launch(fake)["players"]
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(first["computerUseOwnershipCheck"]["status"], "unavailable")
        self.assertEqual(first["error"], "Ownership unavailable")
        self.assertEqual(second["status"], "not-dispatched")
        self.assertEqual([c[3].rsplit("/", 1)[-1] for c in fake.posts()], ["work", "computer-use"])

    def test_invalid_run_pagination_cursor_fails_closed(self):
        for cursor in (True, "200", 0, -1):
            fake = fleet.CLI()
            with patch.object(fake, "get", return_value={"items": [], "nextOffset": cursor}):
                with self.subTest(cursor=cursor), self.assertRaises(fleet.FleetError):
                    fake.pages("A", "/runs")

    def test_unknown_write_blocks_second_player_without_retry(self):
        fake = FakeCLI(True)
        same_pc(fake)
        fake.fail_work.add("A")
        first, second = launch(fake)["players"]
        self.assertEqual(first["status"], "unknown")
        self.assertEqual(second["status"], "not-dispatched")
        self.assertEqual(len(fake.posts()), 1)


if __name__ == "__main__":
    unittest.main()
