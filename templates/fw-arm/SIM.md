# The arm's simulation protocol (UART1, 921600 baud, ASCII lines)

The simulation build (`pio run -e esp32s3_sim`) runs in Espressif's QEMU, whose ESP32-S3 has no I2C controller. Its
UART1 is a socket the MuJoCo bridge (py/mech/arm_drive.py) connects to. The firmware is the board's: the same PCA9685
driver (`src/servo_pca9685.cpp`) writes the same register bytes; only the bus under it (`src/link.h`) differs, Wire on
the board (`link_board.cpp`), these lines in simulation (`link_sim.cpp`). Lock-step: the firmware waits for each answer.

- firmware → bridge: `I <addr> <b0> <b1> …`: one I2C write transaction, hex. The bridge's model of the chip at that
  address takes it: the PCA9685 at 0x40 (NXP datasheet rev 4) keeps its registers, so the driver's order matters as on
  the chip (PRE_SCALE takes only while MODE1's SLEEP is set; LEDn registers auto-increment only with MODE1's AI; no
  output while asleep). Each channel's pulse goes back through its servo's pulse range and travel to the joint angle
  (src/arm/firmware.ts armServos), which sets that joint's position actuator.
- firmware → bridge: `T <tick>`: the end of one control tick (ARM_PERIOD_MS); bridge → firmware: `S <now_ms>`, the
  physics stepped by one period.
- firmware → bridge, at the end: `E <tick>`.

Not exercised in simulation: the ESP32's I2C peripheral and the Wire library (the bytes they would carry are the ones
above), and the servos' calibration offsets (NVS starts empty, so every offset is 0).
