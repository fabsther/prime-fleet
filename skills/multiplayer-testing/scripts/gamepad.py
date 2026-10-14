"""Virtual Xbox 360 gamepad for game test players (ViGEmBus + vgamepad). Windows only.

Install once per PC:  python gamepad.py setup      (creates %LOCALAPPDATA%/prime-fleet/gamepad venv, installs vgamepad; ViGEmBus needs one UAC approval)
Run a sequence:       python gamepad.py run "move 0 1 1.5; look 0.6 0 0.4; press A; hold RT 1.2; hold LT 1; wait 2"
Actions: move X Y SECONDS (left stick, -1..1) | look X Y SECONDS (right stick) | press A|B|X|Y|LB|RB|START|BACK|UP|DOWN|LEFT|RIGHT
         | hold BUTTON|LT|RT SECONDS | wait SECONDS. The game window must have focus (check with Computer Use first).
"""
import os, subprocess, sys, time
VENV = os.path.join(os.environ.get("LOCALAPPDATA", ""), "prime-fleet", "gamepad")
PY = os.path.join(VENV, "Scripts", "python.exe")

def setup():
    if not os.path.exists(PY):
        subprocess.check_call(["uv", "venv", VENV, "--python", "3.12"]) if subprocess.call(["uv", "--version"], stdout=subprocess.DEVNULL) == 0 \
            else subprocess.check_call([sys.executable, "-m", "venv", VENV])
    subprocess.check_call([PY, "-m", "pip", "install", "-q", "vgamepad"]) if subprocess.call([PY, "-m", "pip", "--version"], stdout=subprocess.DEVNULL) == 0 \
        else subprocess.check_call(["uv", "pip", "install", "--python", PY, "vgamepad"])
    print(subprocess.run(["sc", "query", "ViGEmBus"], capture_output=True, text=True).stdout or "ViGEmBus missing: approve the UAC prompt of vgamepad's installer")

def run(seq):
    import vgamepad as vg
    B = vg.XUSB_BUTTON
    names = {"A": B.XUSB_GAMEPAD_A, "B": B.XUSB_GAMEPAD_B, "X": B.XUSB_GAMEPAD_X, "Y": B.XUSB_GAMEPAD_Y,
             "LB": B.XUSB_GAMEPAD_LEFT_SHOULDER, "RB": B.XUSB_GAMEPAD_RIGHT_SHOULDER, "START": B.XUSB_GAMEPAD_START,
             "BACK": B.XUSB_GAMEPAD_BACK, "UP": B.XUSB_GAMEPAD_DPAD_UP, "DOWN": B.XUSB_GAMEPAD_DPAD_DOWN,
             "LEFT": B.XUSB_GAMEPAD_DPAD_LEFT, "RIGHT": B.XUSB_GAMEPAD_DPAD_RIGHT}
    g = vg.VX360Gamepad(); time.sleep(0.5)
    for step in filter(None, (s.strip() for s in seq.split(";"))):
        op, *a = step.split(); op = op.lower()
        if op in ("move", "look"):
            (g.left_joystick_float if op == "move" else g.right_joystick_float)(float(a[0]), float(a[1])); g.update()
            time.sleep(float(a[2])); g.reset(); g.update()
        elif op == "press":
            g.press_button(names[a[0].upper()]); g.update(); time.sleep(0.12); g.release_button(names[a[0].upper()]); g.update()
        elif op == "hold":
            k = a[0].upper()
            if k in ("LT", "RT"): (g.left_trigger if k == "LT" else g.right_trigger)(255)
            else: g.press_button(names[k])
            g.update(); time.sleep(float(a[1])); g.reset(); g.update()
        elif op == "wait": time.sleep(float(a[0]))
        else: raise SystemExit(f"unknown action: {step}")
        time.sleep(0.15)
    print("done:", seq)

if __name__ == "__main__":
    if sys.argv[1:2] == ["setup"]: setup()
    elif sys.argv[1:2] == ["run"] and len(sys.argv) == 3:
        if os.path.exists(PY): sys.path.insert(0, os.path.join(VENV, "Lib", "site-packages"))
        run(sys.argv[2])
    else: print(__doc__)
