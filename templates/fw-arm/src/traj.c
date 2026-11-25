// The move profile: one time-scaling s(t) for all servos, so they arrive together. The slowest servo for its distance sets
// the cruise time D = max |delta| / speed; a ramp of min(rampS, D) at each end; total D + ramp. Each servo's peak speed is
// then its |delta| / D, at most its limit.
#include <math.h>
#include "arm_logic.h"

void arm_move_plan(arm_move *m, const float from[ARM_NS], const float to[ARM_NS], const float degPerS[ARM_NS], float rampS) {
	float d = 0;
	for (int i = 0; i < ARM_NS; i++) {
		m->from[i] = from[i];
		m->to[i] = to[i];
		const float t = fabsf(to[i] - from[i]) / degPerS[i];
		if (t > d) d = t;
	}
	m->rampS = d < rampS ? d : rampS;
	m->durS = d + m->rampS;
}

void arm_move_at(const arm_move *m, float t, float out[ARM_NS]) {
	float s;
	const float T = m->durS, tr = m->rampS;
	if (T <= 0 || t >= T) s = 1;
	else if (t <= 0) s = 0;
	else {
		const float v = 1.0f / (T - tr);  // the cruise rate of s
		if (tr <= 0) s = t / T;
		else if (t < tr) s = 0.5f * v / tr * t * t;
		else if (t <= T - tr) s = v * (t - tr / 2);
		else s = 1 - 0.5f * v / tr * (T - t) * (T - t);
	}
	for (int i = 0; i < ARM_NS; i++) out[i] = m->from[i] + (m->to[i] - m->from[i]) * s;
}
