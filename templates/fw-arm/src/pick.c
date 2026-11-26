// The pick-and-place cycle: above the pick, down (settle), grip, up, above the drop, down (settle), release, up. The approach height starts
// at the task's and drops in 5 mm steps until both "above" points solve (a high drop near full reach may not).
#include "arm_logic.h"

static int pose(const arm_task *t, const float p[3], float dz, float grip, uint16_t hold, arm_waypoint *w) {
	float q[ARM_NJ], s;
	if (arm_solve(&t->g, p[0], p[1], p[2] + dz, q, &s) != 0) return -1;
	for (int i = 0; i < ARM_NJ; i++) w->deg[i] = q[i];
	w->deg[ARM_NJ] = grip;
	w->holdMs = hold;
	return 0;
}

int arm_plan(const arm_task *t, arm_waypoint out[], int max, float *approachUsedMm) {
	if (max < 8) return -1;
	for (float a = t->approachMm; a >= 0; a -= 5) {
		const float o = t->gripOpenDeg, c = t->gripClosedDeg;
		const int bad = pose(t, t->pick, a, o, 0, &out[0]) | pose(t, t->pick, 0, o, t->settleMs, &out[1]) | pose(t, t->pick, 0, c, t->gripHoldMs, &out[2]) |
		                pose(t, t->pick, a, c, 0, &out[3]) | pose(t, t->drop, a, c, 0, &out[4]) | pose(t, t->drop, 0, c, t->settleMs, &out[5]) |
		                pose(t, t->drop, 0, o, t->gripHoldMs, &out[6]) | pose(t, t->drop, a, o, 0, &out[7]);
		if (!bad) {
			if (approachUsedMm) *approachUsedMm = a;
			return 8;
		}
	}
	return -1;
}
