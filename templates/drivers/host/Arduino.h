// The host's stand-in for Arduino.h (host/drivertest.cpp): a fake clock that delay() advances, so a test can see how
// long a driver waited.
#pragma once
#include <stdint.h>
#include <math.h>

namespace host {
inline uint64_t &nowUs() {
	static uint64_t t = 0;
	return t;
}
}  // namespace host
inline void delay(uint32_t ms) { host::nowUs() += (uint64_t)ms * 1000; }
inline void delayMicroseconds(uint32_t us) { host::nowUs() += us; }
inline uint32_t millis() { return (uint32_t)(host::nowUs() / 1000); }
inline uint32_t micros() { return (uint32_t)host::nowUs(); }
