# The arm's simulation protocol (UART1, 921600 baud, ASCII lines)

The simulation build (`pio run -e esp32s3_sim`) runs in Espressif's QEMU; its UART1 is a TCP socket the MuJoCo bridge
connects to. One line each way per control tick (ARM_PERIOD_MS), in lock-step: the firmware waits for the answer.

- firmware → bridge: `A <tick> <deg0> <deg1> <deg2> <deg3> <deg4> <deg5>`: the joint angles the firmware commands, in
  ARM_JOINTS order (base-yaw, shoulder, elbow, wrist-pitch, wrist-roll), then the gripper's (ARM_GRIP_CLOSED_DEG closed,
  ARM_GRIP_OPEN_DEG open). Joint angles as in src/arm/types.ts: 0 stretched forward and level, each relative to the link
  before it.
- bridge → firmware: `S <now_ms>`: the bridge has stepped the physics by one control period.
- firmware → bridge, at the end: `E <tick>`.

Only `src/servo_uart.cpp` differs from the board build (`src/servo_pca9685.cpp`); the IK, the moves and the pick plan
are the same code. The simulation doesn't exercise the I2C driver: its register bytes are checked on the host against
the PCA9685 datasheet (test/arm-firmware.test.ts).
