// The simulation's servo back end (-DHW_SIM): each tick sends the six joint angles to the bridge on UART1 and waits for
// it to step the physics (SIM.md): "A <tick> <deg0> … <deg5>", answered "S <now_ms>". The end: "E <tick>".
#ifdef HW_SIM
#include <Arduino.h>
#include "arm.h"
#include "arm_logic.h"
#include "servo_out.h"

static float deg[ARM_NS];
static uint32_t tick = 0, now = 0;

void servo_begin(void) { Serial1.begin(921600); }

void servo_write(int s, float j) { deg[s] = j; }

uint32_t servo_flush(void) {
	Serial1.printf("A %lu %.2f %.2f %.2f %.2f %.2f %.2f\n", (unsigned long)tick++, deg[0], deg[1], deg[2], deg[3], deg[4], deg[5]);
	char line[48];
	size_t n = 0;
	for (;;) {
		while (!Serial1.available()) delay(0);
		const char c = (char)Serial1.read();
		if (c == '\n') break;
		if (n + 1 < sizeof line) line[n++] = c;
	}
	line[n] = 0;
	unsigned long t;
	if (sscanf(line, "S %lu", &t) == 1) now = t;
	return now;
}

void servo_done(void) { Serial1.printf("E %lu\n", (unsigned long)tick); }
#endif
