// Bringup's stand-in for a Sensirion SHTC3 (SHTC3 datasheet v4) in Wokwi, which has no SHTC3 part. I2C address 0x70.
// Commands are 16-bit: wakeup 0x3517, measure T first / normal mode / no clock stretching 0x7866, sleep 0xB098. After
// a measure it answers six bytes: T (2) + CRC, RH (2) + CRC, CRC-8 poly 0x31 init 0xFF, for a fixed 21.50 °C and
// 48.0 %RH (src/codegen/wokwi.ts SIM_READING; test/wokwi.test.ts checks the bytes decode to that). It answers only
// when awake, like the part. Compiled to chips/shtc3.chip.wasm (NOTES.md).
#include "wokwi-api.h"
#include <stdlib.h>

static const uint8_t READING[6] = {0x61, 0x48, 0xA4, 0x7A, 0xE1, 0xA4};

typedef struct {
	uint16_t command;
	uint8_t bytes;
	uint8_t next;
	bool awake;
	bool ready;
} chip_state_t;

static bool on_connect(void *user_data, uint32_t address, bool read) {
	chip_state_t *chip = user_data;
	if (read) chip->next = 0;
	else chip->bytes = 0;
	return chip->awake || !read;
}

static uint8_t on_read(void *user_data) {
	chip_state_t *chip = user_data;
	if (!chip->ready || chip->next >= 6) return 0xFF;
	return READING[chip->next++];
}

static bool on_write(void *user_data, uint8_t data) {
	chip_state_t *chip = user_data;
	chip->command = (uint16_t)(chip->bytes == 0 ? data << 8 : chip->command | data);
	if (++chip->bytes < 2) return true;
	if (chip->command == 0x3517) chip->awake = true;
	else if (chip->command == 0xB098) chip->awake = chip->ready = false;
	else if (chip->command == 0x7866 && chip->awake) chip->ready = true;
	return true;
}

static void on_disconnect(void *user_data) {}

void chip_init(void) {
	chip_state_t *chip = calloc(1, sizeof(chip_state_t));
	const i2c_config_t config = {
		.user_data = chip,
		.address = 0x70,
		.scl = pin_init("SCL", INPUT),
		.sda = pin_init("SDA", INPUT),
		.connect = on_connect,
		.read = on_read,
		.write = on_write,
		.disconnect = on_disconnect,
	};
	i2c_init(&config);
}
