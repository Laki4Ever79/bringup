// The rover's firmware: each control tick reads the front distance (which paces the loop: the sensor's update period),
// steps the wall-avoidance logic and sets both motors; every 5 s it reads the payload sensor and prints it.
// Each payload reading also goes out over the radio (hw_report: on the board, a BTHome v2 broadcast over BLE).
// A rover that is one board of a system talks to the others over its links (include/link.h, generated from the
// contract, as in the product firmware): started at boot, polled every tick, each payload reading sent on.
#include <Arduino.h>
#include "hw.h"
#include "hw_pins.h"
#include "rover.h"
#ifndef HW_SIM
#define Log Serial  // link.h logs what crosses each link to the console, as the product firmware's Log does
#include "link.h"
#else
// The simulation build talks to its bridge on UART1 (SIM.md), the UART a link would take: no links there.
static void linkBegin() {}
static void linkPoll(uint32_t) {}
static void linkSendReading(bool, float, float) {}
#endif

static const RoverConfig CFG = {ROVER_STOP_MM, ROVER_SLOW_MM, ROVER_CRUISE_DUTY, ROVER_TURN_MS};
static RoverState state;
static uint32_t nextPayload = 0;

void setup() {
	Serial.begin(115200);
	hw_begin();
	linkBegin();  // after hw_begin: the I2C bus is up for a link that shares it
#ifdef LINK_TEST
	// The system's link test, as in the product firmware: a known reading (21.50 C, 40.25 %RH) on each link every half
	// second and whatever arrives printed, for 10 s (the bench build, LINK_TEST_FOREVER, until reset); the motors stay off.
#ifdef LINK_TEST_FOREVER
	for (;;) {
#else
	for (int i = 0; i < 20; i++) {
#endif
		linkSendReading(true, 21.5f, 40.25f);
		linkPoll(500);
	}
	Serial.println("LINK TEST DONE");
	for (;;) delay(1000);
#endif
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
	linkPoll(0);  // what has arrived on the links, without waiting: the distance sensor paces the loop
#ifdef PIN_STATUS_LED
	digitalWrite(PIN_STATUS_LED, (now / 500) % 2);  // a 1 Hz heartbeat: the control loop is running
#endif
	if ((int32_t)(now - nextPayload) >= 0) {
		nextPayload = now + 5000;
		float t = 0, rh = 0;
		const bool ok = hw_payload(&t, &rh);
		if (ok) Serial.printf("PAYLOAD t=%.2f rh=%.1f\n", t, rh);
		hw_report(ok, t, rh);
		linkSendReading(ok, t, rh);
	}
}
