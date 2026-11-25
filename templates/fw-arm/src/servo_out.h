// The arm's servo output: one interface, two back ends. The board build drives the PCA9685 over I2C
// (servo_pca9685.cpp); the simulation build (-DHW_SIM) sends each tick's angles to the MuJoCo bridge over UART1 in
// lock-step (servo_uart.cpp, SIM.md). Everything above it (IK, moves, the pick plan) is the same code in both.
#pragma once
#include <stdint.h>

void servo_begin(void);
void servo_write(int servo, float jointDeg);  // servo 0..5 in ARM_JOINTS order then the gripper; the joint's angle
uint32_t servo_flush(void);                   // ends one control tick (ARM_PERIOD_MS); returns the clock in ms
void servo_done(void);                        // the run's end (the bridge stops stepping)
