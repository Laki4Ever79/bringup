// The simulation's link (-DHW_SIM, SIM.md): every I2C write goes to the MuJoCo bridge on UART1 as "I <addr> <bytes>" (hex),
// where a model of the chip at that address takes it (the PCA9685: its registers become servo pulses, then joint
// angles). Each tick ends with "T <tick>"; the bridge steps the physics one period and answers "S <now_ms>".
#ifdef HW_SIM
#include <Arduino.h>
#include "link.h"

static uint32_t tick = 0, now = 0;

void link_begin(void) { Serial1.begin(921600); }

void link_i2c_write(uint8_t addr, const uint8_t *b, int n) {
	char line[8 + 3 * 40];
	int k = snprintf(line, sizeof line, "I %02x", addr);
	for (int i = 0; i < n && k + 4 < (int)sizeof line; i++) k += snprintf(line + k, sizeof line - k, " %02x", b[i]);
	Serial1.println(line);
}

uint32_t link_tick(uint32_t periodMs) {
	(void)periodMs;  // the bridge steps one period per tick
	Serial1.printf("T %lu\n", (unsigned long)tick++);
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

void link_end(void) { Serial1.printf("E %lu\n", (unsigned long)tick); }
#endif
