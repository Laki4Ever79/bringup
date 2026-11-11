// The rover's firmware: each control tick reads the front distance (which paces the loop: the sensor's update period),
// steps the wall-avoidance logic and sets both motors; every 5 s it reads the payload sensor and prints it.
// Each payload reading also goes out over the radio (hw_report: on the board, a BTHome v2 broadcast over BLE).
#include <Arduino.h>
#include "hw.h"
#include "hw_pins.h"
#include "rover.h"

static const RoverConfig CFG = {ROVER_STOP_MM, ROVER_SLOW_MM, ROVER_CRUISE_DUTY, ROVER_TURN_MS};
static RoverState state;
static uint32_t nextPayload = 0;

void setup() {
	Serial.begin(115200);
	hw_begin();
#ifdef PIN_STATUS_LED
	pinMode(PIN_STATUS_LED, OUTPUT);
#endif
	Serial.println("ROVER ready");
}

void loop() {
	int d = hw_distance_mm();
	uint32_t now = hw_now_ms();
	RoverOut out = rover_step(CFG, state, d, now);
	hw_motor(0, out.left);
	hw_motor(1, out.right);
#ifdef PIN_STATUS_LED
	digitalWrite(PIN_STATUS_LED, (now / 500) % 2);  // a 1 Hz heartbeat: the control loop is running
#endif
	if ((int32_t)(now - nextPayload) >= 0) {
		nextPayload = now + 5000;
		float t = 0, rh = 0;
		const bool ok = hw_payload(&t, &rh);
		if (ok) Serial.printf("PAYLOAD t=%.2f rh=%.1f\n", t, rh);
		hw_report(ok, t, rh);
	}
}
