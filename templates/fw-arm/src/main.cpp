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
	for (int i = 0; i < ARM_NS; i++) pose[i] = w[0].deg[i];
	for (int i = 0; i < ARM_NS; i++) servo_write(i, pose[i]);
	for (int r = 0; r < ARM_REPEATS; r++) {
		for (int k = 0; k < n; k++) go(w[k].deg, w[k].holdMs);
		Serial.printf("ARM cycle %d done\n", r + 1);
	}
	servo_done();
	Serial.println("ARM done");
}

void loop() { delay(1000); }
