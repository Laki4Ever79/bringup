// One stored reading in DF_RECORD_BYTES (include/dataformat.h, generated from the same source as the reader). Plain
// C++, so test/data-format.test.ts packs readings with this very code on the host and decodes them with the
// generated Python reader.
#pragma once
#include <stdint.h>
#include <math.h>
#include "dataformat.h"

static inline uint32_t packReading(float tempC, float rh) {
	long t = lroundf((tempC + DF_TEMP_OFFSET_C) * DF_TEMP_SCALE);
	long h = lroundf(rh * DF_RH_SCALE);
	if (t < 0) t = 0;
	if (t > 65535) t = 65535;
	if (h < 0) h = 0;
	if (h > 10000) h = 10000;
	return (uint32_t)t << 16 | (uint32_t)h;
}
