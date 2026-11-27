// Inverse kinematics, mirrored from src/arm/kinematics.ts solve (the host test compares the two on random points).
#include <math.h>
#include "arm_logic.h"
// pi without M_PI, which MinGW's strict mode doesn't define (OS smoke run 7, Windows).
#ifndef BRINGUP_PI
#define BRINGUP_PI 3.14159265358979323846
#endif

#define DEG (180.0 / BRINGUP_PI)

static double clamp1(double v) { return v < -1 ? -1 : v > 1 ? 1 : v; }

int arm_solve(const arm_geom *g, float x, float y, float z, float out[ARM_NJ], float *shortMm) {
	const double yaw = atan2(y, x) * DEG;
	const double last = -90.0;  // the gripper straight down: the last link's absolute pitch
	const double r = hypot(x, y) - g->yawOffMm - g->l3 * cos(last / DEG);
	const double zz = z - g->shoulderZMm - g->l3 * sin(last / DEG);
	const double d = hypot(r, zz);
	const double l1 = g->l1, l2 = g->l2;
	if (shortMm) *shortMm = 0;
	if (d > l1 + l2 || d < fabs(l1 - l2)) {
		if (shortMm) *shortMm = (float)(d > l1 + l2 ? d - (l1 + l2) : fabs(l1 - l2) - d);
		return 1;
	}
	for (int sign = -1; sign <= 1; sign += 2) {  // elbow up first
		const double el = sign * acos(clamp1((d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2)));
		const double sh = atan2(zz, r) - atan2(l2 * sin(el), l1 + l2 * cos(el));
		const double q[ARM_NJ] = {yaw, sh * DEG, el * DEG, last - sh * DEG - el * DEG, 0};
		int ok = 1;
		for (int i = 0; i < ARM_NJ; i++)
			if (q[i] < g->minDeg[i] - 1e-6 || q[i] > g->maxDeg[i] + 1e-6) ok = 0;
		if (ok) {
			for (int i = 0; i < ARM_NJ; i++) out[i] = (float)q[i];
			return 0;
		}
	}
	return 2;
}

void arm_forward(const arm_geom *g, const float deg[ARM_NJ], float tip[3]) {
	const double a1 = deg[1] / DEG, a2 = a1 + deg[2] / DEG, a3 = a2 + deg[3] / DEG;
	const double r = g->yawOffMm + g->l1 * cos(a1) + g->l2 * cos(a2) + g->l3 * cos(a3);
	const double zz = g->l1 * sin(a1) + g->l2 * sin(a2) + g->l3 * sin(a3);
	tip[0] = (float)(r * cos(deg[0] / DEG));
	tip[1] = (float)(r * sin(deg[0] / DEG));
	tip[2] = (float)(zz + g->shoulderZMm);
}
