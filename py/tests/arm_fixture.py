"""The arm fixture shared by the arm tests: test/arm-contract.test.ts ARM and TARGETS."""

# test/arm-contract.test.ts ARM: the limits the sweep found clean (yaw ±60, elbow -90..30, wrist -120..60).
ARM = {
    "base": {"plateMm": [200, 160], "thicknessMm": 5, "shoulderZMm": 60, "holdDown": "mass", "ballastG": 300},
    "joints": [
        {"name": "base-yaw", "servo": "MG996R", "channel": 0, "linkMm": 0, "minDeg": -60, "maxDeg": 60},
        {"name": "shoulder", "servo": "MG996R", "channel": 1, "linkMm": 120, "minDeg": 0, "maxDeg": 120},
        {"name": "elbow", "servo": "MG996R", "channel": 2, "linkMm": 110, "minDeg": -90, "maxDeg": 30},
        {"name": "wrist-pitch", "servo": "SG90", "channel": 3, "linkMm": 20, "minDeg": -120, "maxDeg": 60},
        {"name": "wrist-roll", "servo": "SG90", "channel": 4, "linkMm": 30, "minDeg": -90, "maxDeg": 90},
    ],
    "gripper": {"servo": "SG90", "channel": 5, "openMm": 40, "fingerMm": 30},
    "railV": 6,
    "input": {"kind": "dc-brick", "volts": 12, "amps": 3},
    "boards": [{"name": "main", "at": {"xMm": -60, "yMm": 0}, "rotDeg": 0}],
}
TARGETS = {"reachMm": 280, "payloadG": 100, "pick": {"xMm": 180, "yMm": -125, "zMm": 20}, "drop": {"xMm": 160, "yMm": 125, "zMm": 60}, "repeats": 5, "objectG": 50}
