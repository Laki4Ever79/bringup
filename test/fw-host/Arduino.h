// The little of Arduino.h that linkframe.h uses, so the codec compiles and runs on the host (test/linkframe-host.test.ts).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

class Print {
public:
	virtual ~Print() {}
	virtual size_t write(uint8_t c) = 0;
	virtual size_t write(const uint8_t *p, size_t n) {
		for (size_t i = 0; i < n; i++) write(p[i]);
		return n;
	}
};
