# The rover's simulation protocol (UART1, 921600 baud, ASCII lines)

The simulation build (`pio run -e esp32c3_sim`) runs in Espressif's QEMU; its UART1 is a TCP socket the bridge
(`py/mech/drive.py`) connects to. One line each way per control tick, in lock-step: the firmware waits for the answer,
so physics and firmware stay in step whatever the host's speed.

- firmware → bridge: `M <tick> <dutyLeft> <dutyRight>` — the duties the firmware set (−1…1, sign = direction).
- bridge → firmware: `S <now_ms> <distance_mm|-1> <temp_c> <rh>` — the bridge has stepped the physics by one control
  period (the sensor's update period, ROVER_PERIOD_MS); −1 means nothing within the sensor's range.

Only `src/hw_sim.cpp` differs from the board build (`src/hw_board.cpp`); the control logic (`src/rover.cpp`) and the
loop (`src/main.cpp`) are the same program.
