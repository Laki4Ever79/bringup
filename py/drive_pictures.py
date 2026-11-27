"""Pictures of the rover's simulated drive (py/mech/drive.py), drawn from its trajectory without MuJoCo or OpenGL: the
robot's own chassis and bought parts (stills.py's meshes and rasterizer) placed at each recorded pose on the course.
A Claude Code user sees the robot drive, not only its board.

usage: drive_pictures.py <chassis rev dir (spec.json, chassis.stl)> <drive rev dir (drive.json, trajectory.json)> <out dir>
writes drive-track.png (from above: the course, the path, the robot where it started and ended), drive-1-start.png,
drive-2-farthest.png, drive-3-end.png (from the front left, above) and drive.gif (the whole drive in about 5 s);
prints the files written, one per line.

Trajectory rows (drive.py): [t s, x m, y m, yaw rad, left duty, right duty, rise mm, ...]. The chassis frame is the
drive's: x from the plate's centre, forward; z 0 the plate's underside, which stands clearanceMm above the floor."""

import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from mech.course import BACK_WALL_X, FRONT_WALL_X, SIDE_WALL_Y, STEP_X  # noqa: E402
from stills import COLOURS, groups, render  # noqa: E402

WALL_MM = 60  # drawn low, so the walls don't hide the robot (the simulation's are 300 mm)
WALL = (196, 192, 182)
STEP = (170, 172, 190)
PATH = (214, 60, 52)
GIF_SIZE = (640, 480)
GIF_FRAMES = 20
FOLLOW_MM = 700  # the key frames and the GIF follow the robot: a window this far each way around it, one scale throughout


def box(x0, y0, z0, x1, y1, z1):
    """Triangles (12, 3, 3) of an axis-aligned box, outward winding."""
    v = np.array([[x, y, z] for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)], dtype=float)
    faces = [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6), (0, 1, 4), (1, 5, 4), (2, 6, 3), (3, 6, 7), (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]
    return v[np.array(faces)]


def course(edge_mm):
    """The course's walls and step, mm."""
    mm = 1000
    fx, bx, sy, t = FRONT_WALL_X * mm, BACK_WALL_X * mm, SIDE_WALL_Y * mm, 20
    walls = np.concatenate([box(fx, -sy - t, 0, fx + t, sy + t, WALL_MM), box(bx - t, -sy - t, 0, bx, sy + t, WALL_MM), box(bx, sy, 0, fx, sy + t, WALL_MM), box(bx, -sy - t, 0, fx, -sy, WALL_MM)])
    parts = [(walls, WALL)]
    if edge_mm > 0:
        parts.append((box(STEP_X * mm, -sy, 0, fx, sy, edge_mm), STEP))
    return parts


def path_ribbon(traj, upto, z):
    """The path driven up to row `upto`, as a flat ribbon 16 mm wide, mm."""
    pts = np.array([[r[1] * 1000, r[2] * 1000] for r in traj[: upto + 1]])
    out = []
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        d = np.array([x1 - x0, y1 - y0])
        n = np.linalg.norm(d)
        if n < 1e-6:
            continue
        o = np.array([-d[1], d[0]]) / n * 8
        a, b, c, e = [x0 + o[0], y0 + o[1], z], [x0 - o[0], y0 - o[1], z], [x1 + o[0], y1 + o[1], z], [x1 - o[0], y1 - o[1], z]
        out += [[a, b, c], [b, e, c]]
    return (np.array(out, dtype=float), PATH) if out else None


def posed(robot, row, clearance):
    """The robot's parts at one trajectory row: turned by its yaw, moved to its x, y, raised by its rise."""
    _, x, y, yaw = row[:4]
    rise = row[6] if len(row) > 6 else 0.0
    c, s = math.cos(yaw), math.sin(yaw)
    rot = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    shift = np.array([x * 1000, y * 1000, clearance + max(rise, 0.0)])
    return [(t @ rot.T + shift, colour) for t, colour in robot]


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    rev, drive, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    spec = json.loads((rev / "spec.json").read_text())
    traj = json.loads((drive / "trajectory.json").read_text())
    if not traj:
        print("drive_pictures: the trajectory is empty", file=sys.stderr)
        sys.exit(1)
    edge = float(spec.get("edgeMm") or 0)
    clearance = float(spec["plate"]["clearanceMm"])
    robot = [(t, COLOURS[k]) for k, t in groups(spec, rev).items() if len(t)]
    scene = course(edge)
    # Every picture at one scale: the course's corners fix the extent.
    extent = np.concatenate([t.reshape(-1, 3) for t, _ in scene])
    span = (FRONT_WALL_X - BACK_WALL_X) * 1000 * 0.62
    written = []

    def frame(i, path, size=None, ss=None, yaw=215, pitch=28):
        # From behind the start, on the robot's left, above; the window centred on the robot.
        ribbon = path_ribbon(traj, i, 1.0)
        parts = scene + ([ribbon] if ribbon else []) + posed(robot, traj[i], clearance)
        x, y, f = traj[i][1] * 1000, traj[i][2] * 1000, FOLLOW_MM
        window = np.array([[x - f, y - f, 0], [x + f, y + f, 0], [x - f, y + f, 250], [x + f, y - f, 250]])
        kw = {k: v for k, v in (("size", size), ("ss", ss)) if v is not None}
        return render(parts, path, yaw, pitch, 0.0, window, span=f * 1.6, **kw)

    # From above: the whole path, the robot where it ended and, lighter, where it started.
    last = len(traj) - 1
    start = [(t, tuple(int(c + (255 - c) * 0.55) for c in colour)) for t, colour in posed(robot, traj[0], clearance)]
    ribbon = path_ribbon(traj, last, 1.0)
    # yaw 180: the camera behind the start, so forward is up the picture.
    render(scene + start + ([ribbon] if ribbon else []) + posed(robot, traj[last], clearance), out / "drive-track.png", 180, 89.5, 0.0, extent, span=span)
    written.append("drive-track.png")
    farthest = max(range(len(traj)), key=lambda i: traj[i][1])
    for name, i in (("drive-1-start.png", 0), ("drive-2-farthest.png", farthest), ("drive-3-end.png", last)):
        frame(i, out / name)
        written.append(name)
    picks = sorted({round(k * last / (GIF_FRAMES - 1)) for k in range(GIF_FRAMES)})
    frames = [frame(i, None, size=GIF_SIZE, ss=1).convert("P", palette=1, colors=96) for i in picks]
    frames[0].save(out / "drive.gif", save_all=True, append_images=frames[1:], duration=250, loop=0, optimize=True)
    written.append("drive.gif")
    print("\n".join(written))


if __name__ == "__main__":
    main()
