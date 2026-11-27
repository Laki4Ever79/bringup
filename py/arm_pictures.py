"""Pictures of the arm's simulated pick-and-place (py/mech/arm_drive.py), drawn from its trajectory without MuJoCo or
OpenGL: the arm's own printed parts and servos (py/arm.py's posed STLs) moved to each recorded set of joint angles with
py/arm.py's own kinematics, the cup's walls and the cube where the simulation had them. stills.py's rasterizer draws.

usage: arm_pictures.py <posed dir (groups.json, STLs)> <armsim rev dir (trajectory.json, arm.json, contract.json)> <out dir>
writes arm-1-pick.png, arm-2-carry.png, arm-3-drop.png (the first cube lifted, carried, let go), arm-landings.png (from
above: every cube where it came to rest, the cup, the arm at its starting pose) and arm.gif (the first pick and place); prints the files written."""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from arm import poses_of, rest_pose  # noqa: E402
from drive_pictures import box  # noqa: E402
from stills import COLOURS, KIND_COLOURS, read_stl, render  # noqa: E402

CUP = (52, 112, 200)
CUBE = (236, 190, 40)
GIF_SIZE = (640, 480)
GIF_FRAMES = 24


def matrix(loc):
    """A build123d Location as a 4x4 matrix."""
    t = loc.wrapped.Transformation()
    m = np.eye(4)
    for r in range(3):
        for c in range(4):
            m[r, c] = t.Value(r + 1, c + 1)
    return m


def moved(tris, m):
    return tris @ m[:3, :3].T + m[:3, 3]


def oriented_box(pos_mm, mat, half_mm):
    """A box of half sizes half_mm, turned by the 3x3 row-major `mat` and centred at pos_mm."""
    hx, hy, hz = half_mm
    return moved(box(-hx, -hy, -hz, hx, hy, hz), np.vstack([np.hstack([np.array(mat).reshape(3, 3), np.array(pos_mm).reshape(3, 1)]), [0, 0, 0, 1]]))


def quat_mat(w, x, y, z):
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    posed, sim, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    groups = json.loads((posed / "groups.json").read_text())
    traj = json.loads((sim / "trajectory.json").read_text())
    result = json.loads((sim / "arm.json").read_text()) if (sim / "arm.json").exists() else {}
    contract = json.loads((sim / "contract.json").read_text())
    arm = contract.get("values", contract)["arm"]
    frames = traj["frames"]
    if not frames or not traj.get("joints"):
        print("arm_pictures: the trajectory has no joint angles", file=sys.stderr)
        sys.exit(1)
    floor_z = float(groups.get("floorZ", 0))
    # Each body's parts in its own frame: the posed STLs taken back from the pose they were exported at.
    rest = [matrix(m) for m in poses_of(arm, groups.get("pose") or rest_pose(arm))]
    bodies = []
    for k, step in enumerate(groups["steps"]):
        inv = np.linalg.inv(rest[min(k, len(rest) - 1)])
        bodies.append([(moved(read_stl(posed / f), inv), KIND_COLOURS.get(kind, COLOURS["top"])) for f, kind in step["files"]])
    cup = [(np.concatenate([oriented_box([v * 1000 for v in c["pos"]], c["mat"], [v * 1000 for v in c["size"]]) for c in traj["cup"]]), CUP)] if traj.get("cup") else []
    cube_i = traj["bodies"].index("cube") if "cube" in traj["bodies"] else None
    half = [v * 1000 for v in traj.get("cubeHalf", [0.0125] * 3)]

    def cube_at(pose):
        return (oriented_box([v * 1000 for v in pose[:3]], quat_mat(*pose[3:7]).reshape(-1), half), CUBE)

    def scene(i):
        t, poses, deg = frames[i]
        locs = [matrix(m) for m in poses_of(arm, deg[:5])]
        parts = [(moved(tr, locs[min(k, len(locs) - 1)]), c) for k, b in enumerate(bodies) for tr, c in b]
        return parts + cup + ([cube_at(poses[cube_i])] if cube_i is not None else [])

    written = []
    first_drop = (result.get("drops") or [{}])[0].get("tS")
    t_end = first_drop + 0.4 if first_drop else frames[-1][0]
    cycle = [i for i, f in enumerate(frames) if f[0] <= t_end] or [0]
    # One scale for every picture: everywhere the arm reaches in the cycle (every 8th frame), the cup, the floor.
    extent = np.concatenate([tr.reshape(-1, 3)[::7] for i in cycle[::8] + [cycle[-1]] for tr, _ in scene(i)] + [np.array([[0, 0, floor_z]])])
    if cube_i is not None:
        z = [frames[i][1][cube_i][2] for i in cycle]
        z0 = z[0]
        lifted = next((i for i, v in zip(cycle, z) if v - z0 > 0.015), cycle[len(cycle) // 3])
        highest = max(cycle, key=lambda i: frames[i][1][cube_i][2])
        before_drop = max((i for i in cycle if frames[i][0] <= (first_drop or frames[-1][0]) - 0.5), default=cycle[-1])
        keys = [lifted, highest if highest > lifted else (lifted + before_drop) // 2, before_drop]
    else:
        keys = [cycle[len(cycle) // 4], cycle[len(cycle) // 2], cycle[-1]]
    for name, i in zip(("arm-1-pick.png", "arm-2-carry.png", "arm-3-drop.png"), keys):
        render(scene(i), out / name, 215, 26, floor_z, extent)
        written.append(name)
    # From above: a cube at every place one came to rest, the arm at its starting pose (clear of the cup; its last pose
    # stands over it and hid them).
    landed = [(oriented_box(d["atMm"], np.eye(3).reshape(-1), half), CUBE) for d in result.get("drops", [])]
    render([p for p in scene(0) if p[1] != CUBE] + landed, out / "arm-landings.png", 180, 89.5, floor_z, extent)
    written.append("arm-landings.png")
    picks = sorted({cycle[round(k * (len(cycle) - 1) / (GIF_FRAMES - 1))] for k in range(GIF_FRAMES)})
    gif = [render(scene(i), None, 215, 26, floor_z, extent, size=GIF_SIZE, ss=1).convert("P", palette=1, colors=96) for i in picks]
    gif[0].save(out / "arm.gif", save_all=True, append_images=gif[1:], duration=180, loop=0, optimize=True)
    written.append("arm.gif")
    print("\n".join(written))


if __name__ == "__main__":
    main()
