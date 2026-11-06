// The device's own identity, kept in NVS ("identity"): its Bluetooth LE passkey, six digits made by the chip's
// hardware random number generator, different on every device. Nothing ships with a shared default password (EN
// 18031-1 asks for none; the EU Radio Equipment Directive's cybersecurity rules apply since 1 Aug 2025). The factory
// test makes it on the line and prints it for the label; a board that skipped the line makes it on its first boot.
// Call with the radio on: Espressif's esp_random() is truly random only while Wi-Fi or Bluetooth runs.
#pragma once
#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>

static uint32_t devicePasskey(bool *made = nullptr) {
	Preferences p;
	p.begin("identity", false);
	uint32_t pk = p.getUInt("passkey", 0);
	const bool fresh = pk < 100000 || pk > 999999;
	if (fresh) {
		pk = 100000 + esp_random() % 900000;
		p.putUInt("passkey", pk);
	}
	p.end();
	if (made) *made = fresh;
	return pk;
}
