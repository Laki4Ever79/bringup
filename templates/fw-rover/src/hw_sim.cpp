// The simulation build (-DHW_SIM): the four functions talk to the bridge (py/mech/drive.py) over UART1 in lock-step.
// Each hw_distance_mm() is one control tick: it sends the motors' duties ("M <tick> <left> <right>") and waits for the
// bridge to step the physics and answer ("S <now_ms> <distance_mm|-1> <temp_c> <rh> [<enc_left> <enc_right>]"). See SIM.md.
#ifdef HW_SIM
#include <Arduino.h>
#include "hw.h"
#include "hw_pins.h"

static float duty[2] = {0, 0};
static uint32_t now = 0, tick = 0;
static float temp = NAN, hum = NAN;
static long enc[2] = {0, 0};

void hw_begin(void) { Serial1.begin(921600); }

void hw_motor(int side, float d) { duty[side & 1] = d; }

int hw_distance_mm(void) {
	Serial1.printf("M %lu %.3f %.3f\n", (unsigned long)tick++, duty[0], duty[1]);
	char line[96];
	size_t n = 0;
	for (;;) {
		while (!Serial1.available()) delay(0);
		char c = (char)Serial1.read();
		if (c == '\n') break;
		if (n + 1 < sizeof line) line[n++] = c;
	}
	line[n] = 0;
	unsigned long t = 0;
	int d = -1;
	float tc = NAN, rh = NAN;
	long el = 0, er = 0;
	const int n2 = sscanf(line, "S %lu %d %f %f %ld %ld", &t, &d, &tc, &rh, &el, &er);
	if (n2 >= 2) { now = t; temp = tc; hum = rh; }
	if (n2 >= 6) { enc[0] = el; enc[1] = er; }  // a design with wheel encoders: the bridge counts them (SIM.md)
	return d;
}

bool hw_payload(float *temp_c, float *rh) {
	if (isnan(temp)) return false;
	*temp_c = temp;
	*rh = hum;
	return true;
}

uint32_t hw_now_ms(void) { return now; }

int32_t hw_encoder(int side) { return (int32_t)enc[side & 1]; }

// QEMU has no radio: the reading is printed (main.cpp) and the BTHome bytes are the logger's, checked on the host.
void hw_report(bool, float, float) {}
#endif
