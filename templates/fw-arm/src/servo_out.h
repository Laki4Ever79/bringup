// The arm's servo output: the PCA9685 driver (servo_pca9685.cpp) in both builds. Only the bus under it differs (link.h):
// Wire on the board, UART1 to the MuJoCo bridge's model of the chip in the simulation (-DHW_SIM, SIM.md).
#pragma once
#include <stdint.h>

void servo_begin(void);
void servo_write(int servo, float jointDeg);  // servo 0..5 in ARM_JOINTS order then the gripper; the joint's angle
uint32_t servo_flush(void);                   // ends one control tick (ARM_PERIOD_MS); returns the clock in ms
void servo_done(void);                        // the run's end (the bridge stops stepping)
