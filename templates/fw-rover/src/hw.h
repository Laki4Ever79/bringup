// The rover's hardware layer: the only functions that differ between the board build and the simulation build
// (-DHW_SIM). On the board they drive the DRV8833 through LEDC and read the sensors over I2C; in simulation they talk
// to the bridge (py/mech/drive.py) over UART1 in lock-step (SIM.md).
#pragma once
#include <stdint.h>

void hw_begin(void);
void hw_motor(int side, float duty);       // side 0 left, 1 right; duty -1..1 (sign = direction)
int hw_distance_mm(void);                  // the front distance; -1 when nothing is in range. One control tick.
bool hw_payload(float *temp_c, float *rh); // the payload sensor's reading; false when none
uint32_t hw_now_ms(void);                  // the control loop's clock
void hw_report(bool ok, float temp_c, float rh); // the payload reading over the radio (the board: BTHome over BLE)
