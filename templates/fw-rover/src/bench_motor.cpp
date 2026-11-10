// The motor bench test (docs/bench-motor.md), env bench_motor: the left motor, wheel off the floor, steps its duty
// from 0.2 to 1.0 and back to 0, holding each for HOLD_MS. The board can't measure speed or current (no encoder; the
// DRV8833's sense pins go to ground), so it announces each step and you measure: "B <duty> <hold_ms>" when a step
// starts, "B end" when done. Send any character over USB to run it again.
#ifdef BENCH_MOTOR
#include <Arduino.h>
#include "hw.h"

static const uint32_t HOLD_MS = 10000;
static const uint32_t PAUSE_MS = 3000;

static void run_steps(void) {
	for (int i = 2; i <= 10; i++) {
		float duty = i / 10.0f;
		Serial.printf("B %.1f %lu\n", duty, (unsigned long)HOLD_MS);
		hw_motor(0, duty);
		delay(HOLD_MS);
		hw_motor(0, 0);
		delay(PAUSE_MS);
	}
	Serial.println("B end");
}

void setup() {
	Serial.begin(115200);
	hw_begin();
	hw_motor(0, 0);
	hw_motor(1, 0);
	delay(3000);  // time to open the serial monitor
	run_steps();
}

void loop() {
	if (Serial.available()) {
		while (Serial.available()) Serial.read();
		run_steps();
	}
	delay(50);
}
#endif
