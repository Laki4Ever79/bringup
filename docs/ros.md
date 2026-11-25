# ROS 2

Every robot Bringup designs comes with a ROS 2 Jazzy package generated from the same design contract as its board,
firmware and chassis. Change the design, and the package changes with it.

## One command

```bash
docker build -t bringup-ros:jazzy docker/ros                  # once: the ROS image (~1.2 GB)
npm run ros -- out/<run>                                     # test the package: mock hardware, then the firmware in QEMU
npm run ros -- out/<run> --port /dev/ttyACM0                 # the same test on the real robot, plugged in by USB
npm run ros -- out/<run> --workspace ~/robot_ws              # only write the colcon workspace (for the robot's computer)
```

A finished robot run also runs the mock and QEMU tests by itself. Their results are in `out/<run>/ros/ros.json` and
in the report's "ROS 2" section.

## What is generated

`out/<run>/ros/ws/src/` holds two packages:

| Package | What it is |
|---|---|
| `rover_bringup` | the URDF (REP-103 units, REP-105 frames, masses and inertias from the mechanics checks), `config/controllers.yaml` (diff-drive controller, joint state, range and IMU broadcasters), `launch/bringup.launch.py`, `test/acceptance.py` |
| `bringup_hardware` | the ros2_control hardware plugin: the bridge between ROS and the robot's own firmware |

Settings come from the design: wheel separation and radius from the drive; speed limits from the brief, within the
motor's loaded top speed; acceleration limits from the design's `maxAccelMps2`, else half the floor's grip on the
driven wheels (an estimate); the update rate from the firmware's control tick; range limits from the sensor's datasheet.
`npm run ros` writes the package fresh from the run's last chassis spec, so an older run gets today's ROS side.

## How ROS talks to the robot

ROS does not run on the microcontroller. The robot's firmware keeps its own control loop and its safety rule (no
forward drive into an obstacle inside the stop distance), and takes ROS's wheel commands over its USB console:

```
host → robot   H <left> <right>                              wheel duties, -1..1
robot → host   R <ms> <distance_mm|-1> <left> <right> [E <countL> <countR>] [H <heading_mrad>]
```

`E` is sent when the robot has wheel encoders and `H` when it has an IMU. A host that reads only the first four fields
still works. The firmware stops the wheels if no command arrives for a while.

The bridge (`bringup_hardware`) turns this into ros2_control interfaces:

| | With encoders | Without |
|---|---|---|
| wheel position | the firmware's counts × `rad_per_count` (2π / counts per turn, as the firmware counts them) | the applied duty × `max_wheel_rad_s`, integrated (an estimate) |
| wheel velocity | the counts' change over the firmware's own time | the same estimate |
| velocity command → duty | feed-forward from the wheels' speed at duty 1, learned from the encoders (starting at `max_wheel_rad_s`), corrected by a PI loop on each wheel's measured speed | feed-forward from `max_wheel_rad_s` only |
| diff-drive odometry | `open_loop: false`: the wheels' measured turns | `open_loop: true`: the integrated command |

With an IMU, a ros2_control sensor named `imu` carries the gyro's heading as an orientation and its change as the yaw
rate. `imu_sensor_broadcaster` publishes it on `/imu_sensor_broadcaster/imu`. Roll, pitch and the accelerations aren't
measured: their covariances say so (a very large variance; -1 for the accelerations), so a filter such as
robot_localization uses only the heading.

The connection is a serial device for the real robot (`port:=/dev/ttyACM0`) or a TCP port for the firmware in QEMU
(`tcp:127.0.0.1:5555`, the default). In QEMU the firmware's second UART drives the MuJoCo model, so the robot's wheels
turn in physics and the encoder counts and heading come from the simulation. With ROS attached, the simulation is
paced to real time: ROS runs on the wall clock, and unpaced the simulation ran ~2.8× faster, so ROS read about three
times the motion it had commanded.

If the connection drops (QEMU ends, the USB cable comes out), the bridge logs failed writes and ROS keeps running.

## The acceptance test

`test/acceptance.py` runs unchanged against every back end: mock hardware (commands mirrored back), the firmware in
QEMU turning MuJoCo, and the real robot. Its pass marks come from the design:

- odometry is published;
- it drives at the brief's speed (within 10 %, averaged over the last second of a 2 s drive);
- asked for 3× the top speed (in reverse, back toward the start), it moves and is held to the design's top speed;
- range readings arrive, within the sensor's datasheet span;
- with an IMU: its readings arrive, and on a ~1.5 rad turn in place the odometry's heading agrees with the gyro's
  (within 25 %; skipped on mock hardware, which has no gyro).

Each run is recorded as an MCAP bag (`ros/accept/bag-<backend>`). Its topic rates and the speed reached are traced
back to the design: a slow topic points to the bus or the control tick, a short speed points to the motor, gearing or
battery (`src/ros/diagnose.ts`).

## On the real robot

The robot's computer (a Raspberry Pi 5 or a laptop) runs Ubuntu 24.04 with ROS 2 Jazzy:

```bash
npm run ros -- out/<run> --workspace ~/robot_ws               # on the design machine; copy ~/robot_ws to the robot
cd ~/robot_ws && colcon build && source install/setup.bash
ros2 launch rover_bringup bringup.launch.py hardware:=bringup port:=/dev/ttyACM0
ros2 run teleop_twist_keyboard teleop_twist_keyboard --ros-args -p stamped:=true
```

The serial device needs the user in the `dialout` group. `stream:=true` serves the topics to Bringup's dashboard over
rosbridge (ws://127.0.0.1:9090).

## Estimates and limits

- `max_wheel_rad_s` is the motor model's loaded speed (80 % of no-load at the pack's nominal voltage). Without
  encoders, ROS's speed is only as good as this estimate. On the QEMU rover a 0.3 m/s command drove at 0.40 m/s on it
  alone (the simulated motor gives ~15 rad/s per unit duty, the estimate 11.4). With encoders the bridge learns the
  real figure while a wheel runs steadily, and a PI loop (KP 0.5, KI 2.0, no integration until the wheel answers)
  corrects the rest. The gains are estimates, chosen on a wheel model fitted to the QEMU run (0.2 s delay, 0.2 s lag).

Measured on the Eurobot-style rover (encoders and IMU), its firmware in QEMU driving MuJoCo, 23 Nov 2026:

| Check | Open-loop bridge (before) | This bridge |
|---|---|---|
| speed at a 0.3 m/s command | reported 0.3 (the command echoed); the robot drove 0.40 | 0.292 measured |
| asked for 0.9 m/s | reported 0.3 (echoed) | 0.303 measured, in reverse |
| a ~1.5 rad turn: odometry vs gyro | no gyro in ROS | 1.549 vs 1.543 rad |
| odometry vs the simulation's position | not compared | 0.606 vs 0.600 m at the far point |

- `base_link` sits at the drive's pivot (the axle's middle; a skid-steer's halfway between its axles), the point
  diff_drive_controller's odometry moves. Before 25 Nov it sat under the plate's centre, so the robot was drawn (and a
  navigation footprint placed) off its real position after every turn: after a 1.55 rad turn the odometry read
  (0.146, 0.005) m, the simulated axle was at (0.137, 0.005), the plate's centre at (0.209, -0.070). The ROS checks now
  flag a URDF whose wheels aren't at the pivot.
- The IMU's covariances come from the simulated gyro's noise and bias (`spec.imu`), which are estimates, not a
  datasheet.
- Not yet: Nav2 configuration, provisioning the robot's computer, micro-ROS on the microcontroller.
