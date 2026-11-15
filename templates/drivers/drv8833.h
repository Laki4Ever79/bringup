// The DRV8833 dual H-bridge (TI datasheet SLVSAR1, table "H-bridge logic"): per bridge, xIN1 PWM with xIN2 low drives
// forward, xIN1 low with xIN2 PWM drives in reverse, both low coasts. A duty of -1..1 (the sign is the direction)
// becomes the two inputs' PWM levels out of maxLevel. The host tests (host/drivertest.cpp) check this table.
#pragma once

struct Drv8833Levels {
	int in1, in2;
};

static inline Drv8833Levels drv8833Levels(float duty, int maxLevel) {
	if (duty > 1) duty = 1;
	if (duty < -1) duty = -1;
	if (duty != duty) duty = 0;  // NaN from the control loop: coast
	const int level = (int)((duty < 0 ? -duty : duty) * maxLevel);
	return {duty >= 0 ? level : 0, duty >= 0 ? 0 : level};
}
