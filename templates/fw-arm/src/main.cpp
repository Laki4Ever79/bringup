// The arm's program: ARM_REPEATS pick-and-place cycles of the brief's points (include/arm.h, generated from the
// contract), each move synchronised and speed-limited, one servo command per control tick. The log goes to the console.
#include <Arduino.h>
#include "arm.h"
#include "arm_logic.h"
#include "servo_out.h"

static float pose[ARM_NS];

static void go(const float to[ARM_NS], uint16_t holdMs) {
	arm_move m;
	arm_move_plan(&m, pose, to, ARM_DEG_PER_S, ARM_RAMP_S);
	const uint32_t t0 = servo_flush();
	for (uint32_t now = t0;;) {
		const float t = (now - t0) / 1000.0f;
		arm_move_at(&m, t, pose);
		for (int i = 0; i < ARM_NS; i++) servo_write(i, pose[i]);
		now = servo_flush();
		if (t >= m.durS) break;
	}
	for (uint32_t start = servo_flush(), now = start; now - start < holdMs; now = servo_flush())
		for (int i = 0; i < ARM_NS; i++) servo_write(i, pose[i]);
}

void setup() {
	Serial.begin(115200);
	servo_begin();
	arm_task t = ARM_TASK;
	arm_waypoint w[8];
	float approach = 0;
	const int n = arm_plan(&t, w, 8, &approach);
	if (n < 0) {
		Serial.println("ARM plan failed: the pick or drop point can't be reached with the gripper down");
		servo_done();
		return;
	}
	Serial.printf("ARM plan: %d waypoints, approach %.0f mm, %d cycles\n", n, approach, ARM_REPEATS);
#ifdef PIN_STATUS_LED
	// The status LED: on while the arm works, toggled after each cycle, off when it's done.
	pinMode(PIN_STATUS_LED, OUTPUT);
	digitalWrite(PIN_STATUS_LED, HIGH);
#endif
	for (int i = 0; i < ARM_NS; i++) pose[i] = w[0].deg[i];
	// At power-on the servos jump from wherever they are to the first pose at full speed: hold it (gripper open) until the
	// slowest could have crossed its whole travel, before the plan assumes the arm is there.
	for (uint32_t start = servo_flush(), now = start; now - start < ARM_START_MS; now = servo_flush())
		for (int i = 0; i < ARM_NS; i++) servo_write(i, pose[i]);
	for (int r = 0; r < ARM_REPEATS; r++) {
		for (int k = 0; k < n; k++) go(w[k].deg, w[k].holdMs);
		Serial.printf("ARM cycle %d done\n", r + 1);
#ifdef PIN_STATUS_LED
		digitalWrite(PIN_STATUS_LED, r % 2 ? HIGH : LOW);
#endif
	}
	servo_done();
#ifdef PIN_STATUS_LED
	digitalWrite(PIN_STATUS_LED, LOW);
#endif
	Serial.println("ARM done");
}

void loop() { delay(1000); }
