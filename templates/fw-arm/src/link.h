// The arm's link to the outside: the I2C bus the servo driver talks on, and the control tick. Two back ends: the board's
// (link_board.cpp: Wire, millis) and the simulation's (link_sim.cpp, -DHW_SIM: both over UART1 to the MuJoCo bridge in
// lock-step, SIM.md). The PCA9685 driver above it (servo_pca9685.cpp) is the same code in both builds.
#pragma once
#include <stdint.h>

void link_begin(void);
void link_i2c_write(uint8_t addr, const uint8_t *bytes, int n);  // one I2C write transaction
uint32_t link_tick(uint32_t periodMs);                          // ends one control tick; returns the clock in ms
void link_end(void);                                            // the run's end
