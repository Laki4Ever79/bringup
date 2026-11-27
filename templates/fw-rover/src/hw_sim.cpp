// The simulation build (-DHW_SIM): the four functions talk to the bridge (py/mech/drive.py) over UART1 in lock-step.
// Each hw_distance_mm() is one control tick: it sends the motors' duties ("M <tick> <left> <right>") and waits for the
// bridge to step the physics and answer ("S <now_ms> <distance_mm|-1> <temp_c> <rh> [<enc_left> <enc_right>] [H <heading_mrad>]"). See SIM.md.
#ifdef HW_SIM
#include <string.h>
#include <Arduino.h>
#include "hw.h"
#include "hw_pins.h"

static float duty[2] = {0, 0};
static uint32_t now = 0, tick = 0;
static float temp = NAN, hum = NAN;
#ifdef ROVER_TURN_COUNTS
static long enc[2] = {0, 0};
#endif
static float heading = NAN;

void hw_begin(void) { Serial1.begin(921600); }

// SIM_NO_STACK_GUARD_IRQ (the simulation build only, never the board's): the ESP32-C3's stack guard (its debug-assist
// interrupt, CPU line 27) masked before loopTask starts. Espressif's Windows QEMU raised it with nothing tripped and the
// firmware panicked in a loop ("Stack protection fault ... ASSIST_DEBUG is not triggered BUT interrupt occurred!", MCAUSE
// 27; GitHub's Windows runner, 27 Nov 2026). Arduino calls initVariant() from initArduino(), before loopTask.
#if defined(SIM_NO_STACK_GUARD_IRQ) && defined(CONFIG_IDF_TARGET_ESP32C3)
#include "riscv/interrupt.h"
#include "soc/soc.h"
extern "C" void initVariant(void) { esprv_int_disable(1u << ETS_ASSIST_DEBUG_INUM); }
#endif

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
#ifdef ROVER_TURN_COUNTS
	long el = 0, er = 0;
	const int n2 = sscanf(line, "S %lu %d %f %f %ld %ld", &t, &d, &tc, &rh, &el, &er);
	if (n2 >= 2) { now = t; temp = tc; hum = rh; }
	if (n2 >= 6) { enc[0] = el; enc[1] = er; }  // a design with wheel encoders: the bridge counts them (SIM.md)
#else
	if (sscanf(line, "S %lu %d %f %f", &t, &d, &tc, &rh) >= 2) { now = t; temp = tc; hum = rh; }
#endif
	// The board's gyro, when the design has an IMU: " H <heading mrad>" after the rest (the drive bridge's estimate).
	const char *h = strstr(line, " H ");
	if (h) heading = atol(h + 3) / 1000.0f;
	return d;
}

bool hw_payload(float *temp_c, float *rh) {
	if (isnan(temp)) return false;
	*temp_c = temp;
	*rh = hum;
	return true;
}

uint32_t hw_now_ms(void) { return now; }

#ifdef ROVER_TURN_COUNTS
int32_t hw_encoder(int side) { return (int32_t)enc[side & 1]; }
#endif

// QEMU has no radio: the reading is printed (main.cpp) and the BTHome bytes are the logger's, checked on the host.
void hw_report(bool, float, float) {}
// The simulation has no gyro (the bridge sends wheel counts only): the turn closes on the counts, as without an IMU.
float hw_heading_rad(void) { return heading; }  // NAN until the bridge sends one (a design without an IMU never does)
#endif
