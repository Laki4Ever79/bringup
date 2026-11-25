// Host harness for the arm firmware's logic (test/arm-firmware.test.ts): reads commands on stdin, prints one JSON line
// each. Built against a prepared firmware folder's include/arm.h and the template's C sources.
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "arm.h"
#include "arm_logic.h"

int main(void) {
	arm_task t = ARM_TASK;
	char cmd[16];
	while (scanf("%15s", cmd) == 1) {
		if (!strcmp(cmd, "solve")) {
			float x, y, z, q[ARM_NJ] = {0}, s = 0;
			scanf("%f %f %f", &x, &y, &z);
			const int r = arm_solve(&t.g, x, y, z, q, &s);
			printf("{\"r\":%d,\"short\":%.4f,\"q\":[%.6f,%.6f,%.6f,%.6f,%.6f]}\n", r, s, q[0], q[1], q[2], q[3], q[4]);
		} else if (!strcmp(cmd, "forward")) {
			float q[ARM_NJ], p[3];
			for (int i = 0; i < ARM_NJ; i++) scanf("%f", &q[i]);
			arm_forward(&t.g, q, p);
			printf("{\"p\":[%.4f,%.4f,%.4f]}\n", p[0], p[1], p[2]);
		} else if (!strcmp(cmd, "move")) {
			float a[ARM_NS], b[ARM_NS], o[ARM_NS], prev[ARM_NS], peak[ARM_NS] = {0};
			for (int i = 0; i < ARM_NS; i++) scanf("%f", &a[i]);
			for (int i = 0; i < ARM_NS; i++) scanf("%f", &b[i]);
			arm_move m;
			arm_move_plan(&m, a, b, ARM_DEG_PER_S, ARM_RAMP_S);
			const float dt = 0.001f;
			memcpy(prev, a, sizeof prev);
			for (float tt = dt; tt <= m.durS + dt; tt += dt) {
				arm_move_at(&m, tt, o);
				for (int i = 0; i < ARM_NS; i++) { const float v = fabsf(o[i] - prev[i]) / dt; if (v > peak[i]) peak[i] = v; prev[i] = o[i]; }
			}
			arm_move_at(&m, m.durS, o);
			printf("{\"dur\":%.5f,\"peak\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],\"end\":[%.4f,%.4f,%.4f,%.4f,%.4f,%.4f]}\n", m.durS, peak[0], peak[1], peak[2], peak[3], peak[4], peak[5], o[0], o[1], o[2], o[3], o[4], o[5]);
		} else if (!strcmp(cmd, "plan")) {
			arm_waypoint w[8];
			float a = -1;
			const int n = arm_plan(&t, w, 8, &a);
			printf("{\"n\":%d,\"approach\":%.1f,\"w\":[", n, a);
			for (int k = 0; k < (n > 0 ? n : 0); k++) printf("%s{\"deg\":[%.4f,%.4f,%.4f,%.4f,%.4f,%.4f],\"hold\":%u}", k ? "," : "", w[k].deg[0], w[k].deg[1], w[k].deg[2], w[k].deg[3], w[k].deg[4], w[k].deg[5], w[k].holdMs);
			printf("]}\n");
		} else if (!strcmp(cmd, "pca")) {
			int ch, servo;
			float j;
			scanf("%d %f", &servo, &j);
			ch = ARM_CHANNEL[servo];
			const float deg = arm_servo_deg(j, ARM_MIN_DEG[servo], ARM_MAX_DEG[servo], ARM_RANGE_DEG[servo], 0);
			const uint16_t us = arm_pulse_us(deg, ARM_RANGE_DEG[servo], ARM_PULSE_US[servo][0], ARM_PULSE_US[servo][1]);
			uint8_t b[4];
			arm_pca_bytes(arm_pca_ticks(us, ARM_SERVO_HZ), b);
			printf("{\"prescale50\":%u,\"prescale200\":%u,\"reg\":%u,\"servoDeg\":%.3f,\"us\":%u,\"bytes\":[%u,%u,%u,%u]}\n", arm_pca_prescale(50), arm_pca_prescale(200), arm_pca_reg(ch), deg, us, b[0], b[1], b[2], b[3]);
		}
		fflush(stdout);
	}
	return 0;
}
