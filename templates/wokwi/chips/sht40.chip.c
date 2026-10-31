// Bringup's stand-in for a Sensirion SHT40 (SHT4x datasheet v1) in Wokwi, which has no SHT40 part. I2C address 0x44.
// On the "measure T & RH, high precision" command 0xFD it answers six bytes: T (2) + CRC, RH (2) + CRC, CRC-8 poly
// 0x31 init 0xFF, for a fixed 21.50 °C and 48.0 %RH (src/codegen/wokwi.ts SIM_READING; test/wokwi.test.ts checks the
// bytes decode to that). Compiled to chips/sht40.chip.wasm (NOTES.md).
#include "wokwi-api.h"
#include <stdlib.h>

static const uint8_t READING[6] = {0x61, 0x47, 0x8A, 0x6E, 0x97, 0x17};

typedef struct {
	uint8_t next;
	bool ready;
} chip_state_t;

static bool on_connect(void *user_data, uint32_t address, bool read) {
	chip_state_t *chip = user_data;
	if (read) chip->next = 0;
	return true;
}

static uint8_t on_read(void *user_data) {
	chip_state_t *chip = user_data;
	if (!chip->ready || chip->next >= 6) return 0xFF;
	return READING[chip->next++];
}

static bool on_write(void *user_data, uint8_t data) {
	chip_state_t *chip = user_data;
	if (data == 0xFD) chip->ready = true;
	return true;
}

static void on_disconnect(void *user_data) {}

void chip_init(void) {
	chip_state_t *chip = calloc(1, sizeof(chip_state_t));
	const i2c_config_t config = {
		.user_data = chip,
		.address = 0x44,
		.scl = pin_init("SCL", INPUT),
		.sda = pin_init("SDA", INPUT),
		.connect = on_connect,
		.read = on_read,
		.write = on_write,
		.disconnect = on_disconnect,
	};
	i2c_init(&config);
}
