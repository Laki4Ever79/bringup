// The rover's firmware: each control tick reads the front distance (which paces the loop: the sensor's update period),
// steps the wall-avoidance logic and sets both motors; every 5 s it reads the payload sensor and prints it.
// Each payload reading also goes out over the radio (hw_report: on the board, a BTHome v2 broadcast over BLE).
// A rover that is one board of a system talks to the others over its links (include/link.h, generated from the
// contract, as in the product firmware): started at boot, polled every tick, each payload reading sent on.
#include <Arduino.h>
#include "hw.h"
#include "hw_pins.h"
#include "rover.h"
#include "match.h"
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
#if defined(ROVER_TURN_COUNTS) || defined(ROVER_TURN_RAD)
// Wheel encoders (hw_encoder) and/or a gyro (hw_heading_rad, an IMU on the board): the turn closes on the heading, else
// on the wheels' counts, and the straight on the counts (rover_enc.h). Without either this file compiles to exactly what
// it did before.
#define ROVER_ENC_LOGIC 1
#include "rover_enc.h"
#ifndef ROVER_TURN_RAD
#define ROVER_TURN_RAD 0.0f
#endif
#ifndef ROVER_REST_MS
#define ROVER_REST_MS 0
#endif
#ifdef ROVER_TURN_COUNTS
#define ENC_L hw_encoder(0)
#define ENC_R hw_encoder(1)
static const RoverEncConfig ENC_CFG = {ROVER_STOP_MM, ROVER_SLOW_MM, ROVER_CRUISE_DUTY, ROVER_TURN_MS, ROVER_TURN_COUNTS, ROVER_HOLD_GAIN, ROVER_BACK_COUNTS, ROVER_TURN_RAD, 0, ROVER_REST_MS};
#else
#define ENC_L 0
#define ENC_R 0
#ifndef ROVER_BACK_MS
#define ROVER_BACK_MS 0
#endif
static const RoverEncConfig ENC_CFG = {ROVER_STOP_MM, ROVER_SLOW_MM, ROVER_CRUISE_DUTY, ROVER_TURN_MS, 0, 0.0f, 0, ROVER_TURN_RAD, ROVER_BACK_MS, ROVER_REST_MS};
#endif
static RoverEncState encState;
#endif
static RoverState state;
#ifdef ROVER_ENC_COUNTS_PER_REV
#include "rover_odo.h"
static RoverOdo odo;
static RoverGoto go;
static RoverRoute route;
static uint32_t nextOdo = 0;
#endif
#ifdef PIN_START
// A pull-cord start (match.h, Eurobot General Rules 1.2 F.6): no drive until the cord, in at power-up, is pulled; with
// MATCH_MS (H.3) every motor stops for good that long after. The simulation pulls the cord at its first tick.
static MatchState match;
#ifdef PIN_STATUS_LED
#include "status_led.h"
#endif
#if defined(PCA9685_ADDR) && !defined(HW_SIM)
// Servos and a spare motor through a PCA9685 on the I2C bus (pca9685.h): 50 Hz for the servos, the spare motor's two
// inputs on channels SPARE_MOTOR_CH and +1 at the same rate. Host commands: `V <n> <us>` a servo's pulse, `W <duty>`
// the spare motor (-1..1).
#include <Wire.h>
#include "pca9685.h"
static void pcaWrite(uint8_t reg, const uint8_t *b, uint8_t n) {
	Wire.beginTransmission(PCA9685_ADDR);
	Wire.write(reg);
	Wire.write(b, n);
	Wire.endTransmission();
}
static void pcaBegin() {
	uint8_t sleep = 0x10, pre = pca9685_prescale(50), wake = 0x20;  // asleep to set the prescaler, then auto-increment
	pcaWrite(PCA9685_MODE1, &sleep, 1);
	pcaWrite(PCA9685_PRESCALE, &pre, 1);
	pcaWrite(PCA9685_MODE1, &wake, 1);
	delay(1);  // the oscillator's 500 us start
	uint8_t restart = 0xA0;
	pcaWrite(PCA9685_MODE1, &restart, 1);
}
static void pcaServo(uint8_t ch, uint32_t us) {
	const uint16_t off = pca9685_ticks_us(us, 50);
	const uint8_t b[4] = {0, 0, (uint8_t)(off & 0xFF), (uint8_t)(off >> 8)};
	pcaWrite(PCA9685_LED0 + 4 * ch, b, 4);
}
static void pcaDuty(uint8_t ch, float d) {
	uint8_t b[4];
	pca9685_duty_bytes(d, b);
	pcaWrite(PCA9685_LED0 + 4 * ch, b, 4);
}
#endif
#ifndef MATCH_MS
#define MATCH_MS 0xFFFFFFFFUL
#endif
#ifdef HW_SIM
static bool cordInOnce = true;
static bool cordIn(uint32_t) {  // in on the first tick, pulled from the next
	const bool in = cordInOnce;
	cordInOnce = false;
	return in;
}
#else
static bool cordIn(uint32_t) { return digitalRead(PIN_START) == LOW; }
#endif
#endif
static uint32_t nextPayload = 0;

void setup() {
	Serial.begin(115200);
	hw_begin();
#if defined(PIN_START) && !defined(HW_SIM)
	pinMode(PIN_START, INPUT_PULLUP);  // the board's 10k pulls it up too; the cord's loop holds it low
#endif
	linkBegin();  // after hw_begin: the I2C bus is up for a link that shares it
#if defined(PCA9685_ADDR) && !defined(HW_SIM)
	pcaBegin();
	for (uint8_t i = 0; i < SERVO_COUNT; i++) pcaServo(i, 1500);  // the servos centred
#ifdef SPARE_MOTOR_CH
	pcaDuty(SPARE_MOTOR_CH, 0);
	pcaDuty(SPARE_MOTOR_CH + 1, 0);
#endif
#endif
#if defined(ROVER_ENC_COUNTS_PER_REV) && defined(ROVER_GOTO_X_MM)
	// The simulation's go-to test (PLATFORMIO_BUILD_FLAGS): the target from the start.
	rover_route_add(route, ROVER_GOTO_X_MM, ROVER_GOTO_Y_MM);
#endif
#if defined(ROVER_ENC_COUNTS_PER_REV) && defined(ROVER_GOTO_LAP_W_MM)
	// The simulation's lap: a rectangle's corners, counter-clockwise, and back to the start.
	rover_route_add(route, ROVER_GOTO_LAP_W_MM, 0);
	rover_route_add(route, ROVER_GOTO_LAP_W_MM, ROVER_GOTO_LAP_H_MM);
	rover_route_add(route, 0, ROVER_GOTO_LAP_H_MM);
	rover_route_add(route, 0, 0);
#endif
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

// Host mode (docs/ros.md): a ROS 2 host drives the wheels over the console, one line per command, `H <left> <right>`
// (duties -1..1). While its commands keep coming (each one holds for HOST_HOLD_MS) they replace the wall-avoidance
// logic, and every tick reports `R <now_ms> <distance_mm|-1> <left> <right>`. The firmware keeps its own safety: it
// never drives forward into something nearer than its stop distance, whoever asks.
static const uint32_t HOST_HOLD_MS = 500;
static char hostLine[48];
static size_t hostLen = 0;
static float hostLeft = 0, hostRight = 0;
static uint32_t hostAt = 0;
// A ROS test build (-DROVER_HOST_ONLY): the motors stay off until the host commands them, so the test starts from rest.
#ifdef ROVER_HOST_ONLY
static bool hostSeen = true;
#else
static bool hostSeen = false;
#endif

static void hostPoll(uint32_t now) {
	while (Serial.available()) {
		const char c = (char)Serial.read();
		if (c == '\n' || c == '\r') {
			hostLine[hostLen] = 0;
			float l, r;
#ifdef ROVER_ENC_COUNTS_PER_REV
			// `G <x_mm> <y_mm>`: drive to that point (odometry: from where it started, x ahead, y to its left), after the
			// points already queued (a route, up to 16); an H command clears the route and stops it.
			if (hostLen && sscanf(hostLine, "G %f %f", &l, &r) == 2) {
				if (!rover_route_add(route, l, r)) Serial.println("GOTO route full (16 points)");
				hostLen = 0;
				continue;
			}
#endif
#if defined(PCA9685_ADDR) && !defined(HW_SIM)
			if (hostLen && sscanf(hostLine, "V %f %f", &l, &r) == 2) {
				if (l >= 0 && l < SERVO_COUNT && r >= 500 && r <= 2500) pcaServo((uint8_t)l, (uint32_t)r);
				hostLen = 0;
				continue;
			}
#ifdef SPARE_MOTOR_CH
			if (hostLen && sscanf(hostLine, "W %f", &l) == 1) {
				float a, b;
				pca9685_motor(l, a, b);
				pcaDuty(SPARE_MOTOR_CH, a);
				pcaDuty(SPARE_MOTOR_CH + 1, b);
				hostLen = 0;
				continue;
			}
#endif
#endif
			if (hostLen && sscanf(hostLine, "H %f %f", &l, &r) == 2) {
#ifdef ROVER_ENC_COUNTS_PER_REV
				go.active = false;
				go.done = false;
				rover_route_clear(route);
#endif
				hostLeft = constrain(l, -1.0f, 1.0f);
				hostRight = constrain(r, -1.0f, 1.0f);
				hostAt = now;
				hostSeen = true;
			}
			hostLen = 0;
		} else if (hostLen < sizeof hostLine - 1) {
			hostLine[hostLen++] = c;
		}
	}
}

#ifdef ROVER_HOLD_MM
#include "rover_hold.h"
static RoverHold hold;
#endif

void loop() {
	int d = hw_distance_mm();
	uint32_t now = hw_now_ms();
	hostPoll(now);
#ifdef ROVER_HOLD_MM
	// Under a competition's rules: stop for what is ahead and wait for it to leave (rover_hold.h); the drive's own step
	// doesn't run while holding, so it never starts a turn away from the opponent. Without the define (no rules) the
	// lines below build exactly as before.
	const bool holding = rover_hold(hold, d, now, ROVER_HOLD_MM, ROVER_CLEAR_MM, ROVER_BLIND_MM, ROVER_HOLD_MAX_MS);
	if (holding) Serial.printf("HOLD %lu %d\n", (unsigned long)now, d);
#ifdef ROVER_ENC_LOGIC
	RoverOut out = holding ? RoverOut{0, 0} : rover_enc_step(ENC_CFG, encState, d, now, ENC_L, ENC_R, hw_heading_rad());
#else
	RoverOut out = holding ? RoverOut{0, 0} : rover_step(CFG, state, d, now);
#endif
#else
#ifdef ROVER_ENC_LOGIC
	RoverOut out = rover_enc_step(ENC_CFG, encState, d, now, ENC_L, ENC_R, hw_heading_rad());
#else
	RoverOut out = rover_step(CFG, state, d, now);
#endif
#endif
	if (hostSeen) {
		const bool fresh = (uint32_t)(now - hostAt) <= HOST_HOLD_MS;
		out.left = fresh ? hostLeft : 0;
		out.right = fresh ? hostRight : 0;
		// The safety the firmware owns: no forward drive into what the sensor sees within the stop distance.
		if (d >= 0 && d < ROVER_STOP_MM && out.left > 0 && out.right > 0) out.left = out.right = 0;
#ifdef ROVER_HOLD_MM
		if (holding && out.left > 0 && out.right > 0) out.left = out.right = 0;
#endif
		// The report a ROS host reads (templates/ros/bringup_hardware): time, distance, the duties applied, then what the
		// robot measured: " E <left> <right>" its encoder counts (with encoders), " H <mrad>" its gyro heading (with an
		// IMU). A host that reads only the first four fields still parses it.
		Serial.printf("R %lu %d %.3f %.3f", (unsigned long)now, d, out.left, out.right);
#ifdef ROVER_ENC_COUNTS_PER_REV
		Serial.printf(" E %ld %ld", (long)hw_encoder(0), (long)hw_encoder(1));
#endif
		const float headingNow = hw_heading_rad();
		if (!isnan(headingNow)) Serial.printf(" H %ld", lroundf(headingNow * 1000.0f));
		Serial.print("\n");
	}
#ifdef ROVER_ENC_COUNTS_PER_REV
	// Odometry every tick; while a target is set (G, or the simulation's ROVER_GOTO_X_MM) it drives there instead of the
	// avoidance or a host's duties (rover_odo.h). It stops for something in its way: a reading inside the stop (or the
	// opponent hold) distance that is also nearer than the target plus OPPONENT_GAP, not the wall beyond the target.
	rover_odo_step(odo, hw_encoder(0), hw_encoder(1), ROVER_MM_PER_COUNT, ROVER_TRACK_MM, hw_heading_rad());
	rover_route_next(route, go);
	if (go.active) {
		out = rover_goto_step(go, odo, ROVER_CRUISE_DUTY, ROVER_GOTO_MIN_DUTY);
#ifdef ROVER_HOLD_MM
		const int guard = ROVER_HOLD_MM;
#else
		const int guard = ROVER_STOP_MM;
#endif
		if (d >= 0 && d < guard && d < rover_goto_remaining(go, odo) + ROVER_GOTO_GAP_MM && out.left > 0 && out.right > 0) out.left = out.right = 0;
		if (go.done) Serial.printf("GOTO done %.1f %.1f (target %.1f %.1f)\n", odo.x, odo.y, go.tx, go.ty);
	} else if (go.done) {
		out.left = out.right = 0;  // arrived: it stays there until the next G or H
	}
	if ((int32_t)(now - nextOdo) >= 0) {
		nextOdo = now + 500;
		Serial.printf("ODO %lu %.1f %.1f %.3f\n", (unsigned long)now, odo.x, odo.y, odo.th);
	}
#endif
#ifdef PIN_START
	if (!match_step(match, cordIn(now), now, MATCH_MS)) out.left = out.right = 0;
#endif
#ifdef ROVER_RAMP_PER_TICK
	// The acceleration limit (mechanics.drive.maxAccelMps2): each output moves toward its target at most this much a
	// tick, so a tall robot's stops and starts stay inside its tipping margin. Without it, this file is as before.
	static float rampL = 0, rampR = 0;
	auto toward = [](float &at, float want) { const float s = ROVER_RAMP_PER_TICK; at = want > at + s ? at + s : want < at - s ? at - s : want; return at; };
	out.left = toward(rampL, out.left);
	out.right = toward(rampR, out.right);
#endif
	hw_motor(0, out.left);
	hw_motor(1, out.right);
	linkPoll(0);  // what has arrived on the links, without waiting: the distance sensor paces the loop
#ifdef PIN_STATUS_LED
#ifdef PIN_START
	digitalWrite(PIN_STATUS_LED, status_led(match.phase, now));  // ready / running / stopped (status_led.h)
#else
	digitalWrite(PIN_STATUS_LED, (now / 500) % 2);  // a 1 Hz heartbeat: the control loop is running
#endif
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
