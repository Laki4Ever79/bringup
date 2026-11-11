// The firmware's hardware layer (docs/mcu.md, Firmware): the few things the product firmware (src/main.cpp) needs that
// each core does its own way, chosen by the core's ARDUINO_ARCH_* macro. Everything else (Wire, digitalWrite, millis)
// is plain Arduino and works on every core as it is. Include after pins.h.
//
//   Log, logBegin()          the console: every line the firmware prints (the simulator reads it there)
//   HalKv                    a small persistent key -> u32 store (namespace, key): NVS on the ESP32, the EEPROM
//                            emulation on STM32, a file on the RP2040's and nRF52's LittleFS
//   halHistoryMount/Unmount  the storage the reading history lives on; HalHistory reads/writes one 4-byte slot
//   halSleep(s, low, high)   sleep for s seconds, waking early on a pin going low (button) or high (USB sense); every
//                            wake starts again at setup()
//   HAL_RETAINED             a variable kept across that sleep
//   halWokeByPin(pin)        this boot ends a sleep that pin cut short (not STM32: it has no radio to wake for)
//   halUniqueId()            the chip's own 64-bit id
//   halRandom32()            32 random bits
//   HAL_PIN_VALID(p)         a pins.h pin is a pin of this chip (for static_assert)
//   halWireBegin()           the I2C bus on PIN_I2C_SDA/PIN_I2C_SCL, as controller
//   HAL_PRINTF_FLOAT         Log.printf handles %f; without it, print floats with halFixed()
#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <stdint.h>
#include <stdio.h>
#include <math.h>

#ifndef HISTORY_FILE_NAME
#define HISTORY_FILE_NAME "/history.bin"
#endif

#if defined(ARDUINO_ARCH_ESP32)
// ---- ESP32 (Arduino-ESP32) ----------------------------------------------------------------------------------------
#define HAL_ARCH "esp32"
#define HAL_PRINTF_FLOAT 1
#include <esp_sleep.h>
#include <esp_random.h>
#include <LittleFS.h>
#include <Preferences.h>

// The console (docs/system.md, Firmware): every line goes to UART0, which QEMU reads, and to the C3's own USB
// (Serial/JTAG, GPIO18/19), the only port a Bringup board wires out. A USB write never waits for a host (timeout 0):
// with no host, or one that isn't reading, the line is dropped there, so a board on battery never stalls on its log
// (arduino-esp32 HWCDC::write drops when unplugged; checked 11 Nov in the pinned core, framework 4.30312).
// The core declares HWCDCSerial only when USB is the boot console (ARDUINO_USB_CDC_ON_BOOT); the HWCDC class itself is
// always there on the C3, so the console uses the core's instance when there is one (the bench link-test build) and
// its own otherwise; the build flags stay as they are. HWCDC's state is shared and begin() is idempotent either way.
#if defined(HWCDC_SERIAL_IS_DEFINED)
static HWCDC &UsbLog = HWCDCSerial;
#else
static HWCDC UsbLog;
#endif
struct Console : public Print {
	size_t write(uint8_t c) override {
		Serial0.write(c);
		UsbLog.write(c);
		return 1;
	}
	size_t write(const uint8_t *b, size_t n) override {
		Serial0.write(b, n);
		UsbLog.write(b, n);
		return n;
	}
	void flush() {
		Serial0.flush();
		UsbLog.flush();
	}
};
static Console Log;
static void logBegin() {
	Serial0.begin(115200);
	UsbLog.setTxTimeoutMs(0);
	UsbLog.begin();
}

// Kept in the RTC slow memory, which deep sleep powers; lost on power-up and reset.
#define HAL_RETAINED RTC_DATA_ATTR
#define HAL_PIN_VALID(p) ((p) >= 0 && (p) < SOC_GPIO_PIN_COUNT)

// NVS (Preferences): survives deep sleep and power loss.
struct HalKv {
	Preferences p;
	bool begin(const char *ns, bool readOnly) { return p.begin(ns, readOnly); }
	uint32_t get(const char *key, uint32_t def) { return p.getUInt(key, def); }
	void put(const char *key, uint32_t value) { p.putUInt(key, value); }
	void end() { p.end(); }
};

// The history: /history.bin on the flash's LittleFS partition. format: format the partition if it doesn't mount (the
// very first boot).
static bool halHistoryMount(bool format) { return LittleFS.begin(format); }
static void halHistoryUnmount() { LittleFS.end(); }
struct HalHistory {
	File f;
	bool open(bool write) {
		f = write ? LittleFS.open(HISTORY_FILE_NAME, LittleFS.exists(HISTORY_FILE_NAME) ? "r+" : "w+") : LittleFS.open(HISTORY_FILE_NAME, "r");
		return (bool)f;
	}
	bool read(uint32_t slot, uint32_t &record) { return f && f.seek(slot * sizeof(uint32_t)) && f.read((uint8_t *)&record, sizeof record) == sizeof record; }
	bool write(uint32_t slot, uint32_t record) { return f && f.seek(slot * sizeof(uint32_t)) && f.write((const uint8_t *)&record, sizeof record) == sizeof record; }
	void close() {
		if (f) f.close();
	}
};

// Deep sleep: the timer, plus the pins given (-1: none). A low wake (the button, which closes to GND) gets the internal
// pull-up; a high wake (USB sense, held low by its divider) no pull. The wake pins accumulate. Only GPIO0..5 can wake
// the ESP32-C3 from deep sleep (TRM, "Deep-sleep wakeup"); main.cpp asserts that at compile time.
[[noreturn]] static void halSleep(uint32_t seconds, int wakeLowPin, int wakeHighPin) {
	esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
	if (wakeLowPin >= 0) {
		gpio_pullup_en((gpio_num_t)wakeLowPin);
		gpio_pulldown_dis((gpio_num_t)wakeLowPin);
		esp_deep_sleep_enable_gpio_wakeup(1ULL << wakeLowPin, ESP_GPIO_WAKEUP_GPIO_LOW);
	}
	if (wakeHighPin >= 0) {
		gpio_pullup_dis((gpio_num_t)wakeHighPin);
		gpio_pulldown_dis((gpio_num_t)wakeHighPin);
		esp_deep_sleep_enable_gpio_wakeup(1ULL << wakeHighPin, ESP_GPIO_WAKEUP_GPIO_HIGH);
	}
	esp_deep_sleep_start();
}

// Whether this boot is the end of a deep sleep that the given pin cut short.
__attribute__((unused)) static bool halWokeByPin(int pin) { return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_GPIO && (esp_sleep_get_gpio_wakeup_status() & (1ULL << pin)); }

static uint64_t halUniqueId() { return ESP.getEfuseMac(); }
// Truly random only while Wi-Fi or Bluetooth runs (Espressif's esp_random()); a pseudo-random sequence otherwise.
static uint32_t halRandom32() { return esp_random(); }

#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static void halWireBegin() { Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL); }
#endif

#elif defined(ARDUINO_ARCH_STM32)
// ---- STM32 (STM32duino, Arduino_Core_STM32) ------------------------------------------------------------------------
#define HAL_ARCH "stm32"
// Included by macro: PlatformIO's library finder (chain mode) follows every literal #include whatever #if it sits in,
// and would build the ESP32 core's own EEPROM library into the ESP32 firmware. The STM32 env lists both in lib_deps.
#define HAL_EEPROM_HEADER <EEPROM.h>
#include HAL_EEPROM_HEADER
#if __has_include(<STM32LowPower.h>)
#define HAL_LOW_POWER_HEADER <STM32LowPower.h>
#include HAL_LOW_POWER_HEADER
#define HAL_LOW_POWER 1
#endif

// The console: the profile's console UART (pins.h BRINGUP_CONSOLE_*: USART2 on PA2/PA3 on the STM32G031), 115200 8N1.
// Not the variant's Serial: a pin can reach more than one UART, and the core takes the first its pin map lists (PA2 is
// LPUART1 there, which Renode's STM32G0 model doesn't have). So the pins are looked up with each alternate function
// (PA2, PA2_ALT1…) until one lands on the console's instance.
#if !defined(BRINGUP_CONSOLE_TX) || !defined(BRINGUP_CONSOLE_RX)
#error "pins.h has no BRINGUP_CONSOLE_TX/RX: regenerate it for this chip (codegen/firmware.ts pinsHeader)"
#endif
static uint32_t halUartPin(uint32_t pin, const PinMap *map) {
#ifdef BRINGUP_CONSOLE_INSTANCE
	for (uint32_t alt = 0; alt <= (ALTX_MASK >> 8); alt++) {
		const uint32_t p = pin | (alt << 8);
		if (pinmap_find_peripheral(digitalPinToPinName(p), map) == (void *)BRINGUP_CONSOLE_INSTANCE) return p;
	}
#else
	(void)map;
#endif
	return pin;
}
static HardwareSerial Log(BRINGUP_CONSOLE_RX, BRINGUP_CONSOLE_TX);
static void logBegin() {
	Log.setRx(halUartPin(BRINGUP_CONSOLE_RX, PinMap_UART_RX));
	Log.setTx(halUartPin(BRINGUP_CONSOLE_TX, PinMap_UART_TX));
	Log.begin(115200);
}

// .noinit RAM (the core's ldscript adds the section): the startup code neither zeroes nor loads it, so it keeps its value
// across the reset that ends each sleep (halSleep) and any other reset; it holds garbage after power-up, so a retained
// variable needs a check of its own (a magic word) before it is trusted.
#define HAL_RETAINED __attribute__((section(".noinit")))
// A pins.h pin is the variant's own macro (PA5, PB7 = PIN_A8): a pin the package lacks doesn't compile at all, and the
// macro is a digital pin number or an analog alias (PNUM_ANALOG_BASE + n).
#define HAL_PIN_VALID(p) ((uint32_t)(p) < NUM_DIGITAL_PINS || (((uint32_t)(p) & PNUM_ANALOG_BASE) == PNUM_ANALOG_BASE && ((uint32_t)(p) & PNUM_ANALOG_INDEX) < NUM_ANALOG_INPUTS))

// The persistent store: the core's EEPROM emulation, one flash page (E2END + 1 bytes: 2 KB on the G0) mirrored in a RAM
// buffer, or the data EEPROM on chips that have one (STM32L0). Layout: HAL_KV_SLOTS key slots of {hash, value} first,
// then the history (HISTORY_BYTES).
// Flash wear: the page is rated for 10k erases (DS12992 Table 23, NEND). Erasing it on every reading (every 5 min) would
// wear it out in about 35 days. So each wake's 32-bit writes are also kept in a journal in retained RAM (.noinit, which
// survives Stop mode and the reset that follows it), replayed into the buffer on the next wake, and the page is erased
// only when the journal is nearly full: HAL_JOURNAL_ENTRIES / (about 4 writes per reading) readings per erase, 24 at 96
// entries, so about 2.3 years at 5 min. A power loss drops the readings since the last erase (at most 24); a cold boot
// finds no valid journal (magic and checksum) and starts from flash.
#define HAL_KV_SLOTS 8
#define HAL_KV_BYTES (HAL_KV_SLOTS * 8)
#ifndef HISTORY_BYTES
#define HISTORY_BYTES 1024
#endif
static_assert(HAL_KV_BYTES + HISTORY_BYTES <= E2END + 1, "HISTORY_BYTES does not fit the chip's EEPROM emulation");

#if defined(DATA_EEPROM_BASE)
static void halStoreLoad() {}
static uint8_t halStoreRead(uint32_t pos) { return eeprom_read_byte(pos); }
static void halStoreWrite(uint32_t pos, uint8_t v) {
	if (eeprom_read_byte(pos) != v) eeprom_write_byte(pos, v);
}
static void halStoreCommit() {}
#else
static bool halStoreLoaded = false, halStoreDirty = false;
static void halStoreLoad() {
	if (halStoreLoaded) return;
	eeprom_buffer_fill();
	halStoreLoaded = true;
}
static uint8_t halStoreRead(uint32_t pos) {
	halStoreLoad();
	return eeprom_buffered_read_byte(pos);
}
static void halStoreWrite(uint32_t pos, uint8_t v) {
	halStoreLoad();
	if (eeprom_buffered_read_byte(pos) == v) return;
	eeprom_buffered_write_byte(pos, v);
	halStoreDirty = true;
}
#ifndef HAL_JOURNAL_ENTRIES
#define HAL_JOURNAL_ENTRIES 96
#endif
struct HalJournal {
	uint32_t magic, count, check;
	uint16_t pos[HAL_JOURNAL_ENTRIES];
	uint32_t value[HAL_JOURNAL_ENTRIES];
};
static HalJournal halJournal __attribute__((section(".noinit")));
static const uint32_t HAL_JOURNAL_MAGIC = 0xB1A9E5C3u;
static uint32_t halJournalCheck() {
	uint32_t h = halJournal.count * 2654435761u;
	for (uint32_t i = 0; i < halJournal.count; i++) h = (h ^ halJournal.pos[i] ^ halJournal.value[i]) * 16777619u;
	return h;
}
static bool halJournalValid() { return halJournal.magic == HAL_JOURNAL_MAGIC && halJournal.count <= HAL_JOURNAL_ENTRIES && halJournal.check == halJournalCheck(); }
static void halJournalClear() {
	halJournal.magic = HAL_JOURNAL_MAGIC;
	halJournal.count = 0;
	halJournal.check = halJournalCheck();
}
static void halStoreReplay() {
	static bool replayed = false;
	if (replayed) return;
	replayed = true;
	if (!halJournalValid()) return halJournalClear();
	for (uint32_t i = 0; i < halJournal.count; i++)
		for (int b = 0; b < 4; b++) halStoreWrite(halJournal.pos[i] + b, (uint8_t)(halJournal.value[i] >> (8 * b)));
	halStoreDirty = false;  // what the journal holds is already safe in RAM; flash catches up at the next erase
}
// The page is erased only when the journal can't take another wake's writes (8 entries of headroom).
static void halStoreCommit() {
	if (!halStoreDirty && halJournal.count + 8 <= HAL_JOURNAL_ENTRIES) return;
	if (halJournal.count + 8 > HAL_JOURNAL_ENTRIES) {
		eeprom_buffer_flush();
		halJournalClear();
	}
	halStoreDirty = false;
}
#endif
static uint32_t halStoreRead32(uint32_t pos) {
#if !defined(DATA_EEPROM_BASE)
	halStoreLoad();
	halStoreReplay();
#endif
	uint32_t v = 0;
	for (int i = 0; i < 4; i++) v |= (uint32_t)halStoreRead(pos + i) << (8 * i);
	return v;
}
static void halStoreWrite32(uint32_t pos, uint32_t v) {
#if !defined(DATA_EEPROM_BASE)
	halStoreLoad();
	halStoreReplay();
	if (halStoreRead32(pos) == v) return;
	// Journal it (an existing entry for the same word is updated in place), so it survives the reset after sleep.
	uint32_t i = 0;
	while (i < halJournal.count && halJournal.pos[i] != pos) i++;
	if (i == halJournal.count && halJournal.count < HAL_JOURNAL_ENTRIES) halJournal.count++;
	if (i < halJournal.count) {
		halJournal.pos[i] = (uint16_t)pos;
		halJournal.value[i] = v;
		halJournal.check = halJournalCheck();
	} else halStoreDirty = true;  // journal full: this write reaches flash at the next commit
#endif
	for (int i = 0; i < 4; i++) halStoreWrite(pos + i, (uint8_t)(v >> (8 * i)));
}

// Keys are FNV-1a hashes of "namespace/key"; an erased slot reads 0xFFFFFFFF. HAL_KV_SLOTS keys in all.
struct HalKv {
	const char *ns = "";
	static uint32_t hash(const char *ns, const char *key) {
		uint32_t h = 2166136261u;
		for (const char *s = ns; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
		h = (h ^ '/') * 16777619u;
		for (const char *s = key; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
		return h == 0xFFFFFFFFu ? 0xFFFFFFFEu : h;
	}
	int find(uint32_t h, bool orFree) {
		for (int i = 0; i < HAL_KV_SLOTS; i++) {
			const uint32_t k = halStoreRead32(i * 8);
			if (k == h || (orFree && k == 0xFFFFFFFFu)) return i;
		}
		return -1;
	}
	bool begin(const char *name, bool) {
		ns = name;
		halStoreLoad();
		return true;
	}
	uint32_t get(const char *key, uint32_t def) {
		const int i = find(hash(ns, key), false);
		return i < 0 ? def : halStoreRead32(i * 8 + 4);
	}
	void put(const char *key, uint32_t value) {
		const uint32_t h = hash(ns, key);
		const int i = find(h, true);
		if (i < 0) return;  // all HAL_KV_SLOTS taken: the template uses three keys
		halStoreWrite32(i * 8, h);
		halStoreWrite32(i * 8 + 4, value);
	}
	void end() { halStoreCommit(); }
};

static bool halHistoryMount(bool) {
	halStoreLoad();
	return true;
}
static void halHistoryUnmount() { halStoreCommit(); }
struct HalHistory {
	bool open(bool) { return true; }
	bool read(uint32_t slot, uint32_t &record) {
		if ((slot + 1) * sizeof(uint32_t) > HISTORY_BYTES) return false;
		record = halStoreRead32(HAL_KV_BYTES + slot * sizeof(uint32_t));
		return true;
	}
	bool write(uint32_t slot, uint32_t record) {
		if ((slot + 1) * sizeof(uint32_t) > HISTORY_BYTES) return false;
		halStoreWrite32(HAL_KV_BYTES + slot * sizeof(uint32_t), record);
		return true;
	}
	void close() {}
};

#if defined(HAL_LOW_POWER)
static void halWakeNoop() {}
#endif
// Sleep: STM32duino Low Power's deepSleep (Stop mode on the G0: RAM and registers kept, the RTC alarm or an EXTI pin
// wakes it), then a reset, so every wake starts again at setup() as on the ESP32. Any GPIO can wake it (EXTI); a low
// wake gets the internal pull-up, a high wake none (its divider holds it low).
// Without the library (an env that doesn't pin it) it waits awake in delay(): right in behaviour, wrong in current.
[[noreturn]] static void halSleep(uint32_t seconds, int wakeLowPin, int wakeHighPin) {
	Log.flush();
#if defined(HAL_LOW_POWER)
	LowPower.begin();
	if (wakeLowPin >= 0) {
		pinMode(wakeLowPin, INPUT_PULLUP);
		LowPower.attachInterruptWakeup(wakeLowPin, halWakeNoop, FALLING, DEEP_SLEEP_MODE);
	}
	if (wakeHighPin >= 0) {
		pinMode(wakeHighPin, INPUT);
		LowPower.attachInterruptWakeup(wakeHighPin, halWakeNoop, RISING, DEEP_SLEEP_MODE);
	}
	LowPower.deepSleep(seconds * 1000UL);
#else
	(void)wakeLowPin;
	(void)wakeHighPin;
	delay(seconds * 1000UL);
#endif
	NVIC_SystemReset();
	for (;;) {}
}

// The 96-bit unique device ID (RM0444 §40.1): wafer X/Y (word 0) folded with lot and wafer number (words 1, 2).
static uint64_t halUniqueId() { return (uint64_t)(HAL_GetUIDw1() ^ HAL_GetUIDw2()) << 32 | HAL_GetUIDw0(); }
// NOT cryptographic: xorshift32 seeded from the unique ID and the boot's micros(). Different per chip and per boot, fine
// for jitter and ids; a secret (a passkey) needs the chip's RNG peripheral, which the G0 lacks.
static uint32_t halRandom32() {
	static uint32_t x = 0;
	if (x == 0) x = (HAL_GetUIDw0() ^ HAL_GetUIDw1() * 2654435761u ^ HAL_GetUIDw2() ^ micros()) | 1;
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	return x;
}

#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static void halWireBegin() {
	Wire.setSDA(PIN_I2C_SDA);
	Wire.setSCL(PIN_I2C_SCL);
	Wire.begin();
}
#endif

// printf's %f is left out on purpose: newlib-nano's float printf costs about 19 KB of flash, a third of the G031's 64 KB.
// The product firmware prints its readings with halFixed() instead.

#elif defined(ARDUINO_ARCH_RP2040) || defined(ARDUINO_ARCH_MBED_RP2040)
// ---- RP2040 (Arduino's mbed core, framework-arduino-mbed 4.6.0: PlatformIO raspberrypi@1.20.0) --------------------
// The PlatformIO raspberrypi platform builds the RP2040 with Arduino's mbed core, which defines ARDUINO_ARCH_RP2040
// (pico.json) and ARDUINO_ARCH_MBED. Earle Philhower's arduino-pico core is another core with other APIs.
#if !defined(ARDUINO_ARCH_MBED)
#error "hal.h: on the RP2040 only Arduino's mbed core (PlatformIO raspberrypi) is supported, not arduino-pico"
#endif
#define HAL_ARCH "rp2040"
#include <stdarg.h>
#include "FlashIAPBlockDevice.h"
#include "LittleFileSystem.h"
#include "filesystem/File.h"
#include "hardware/clocks.h"
#include "hardware/flash.h"
#include "hardware/gpio.h"
#include "hardware/pll.h"
#include "hardware/rtc.h"
#include "hardware/sync.h"
#include "hardware/watchdog.h"
#include "hardware/structs/rosc.h"
#include "hardware/structs/scb.h"

// The console: UART0 on the profile's pins (GPIO0/GPIO1), 115200 8N1. src/mcu/firmware.ts passes them as
// BRINGUP_CONSOLE_TX/RX from pins.h (the core numbers pins as GPIOs: D0 = GPIO0). The mbed core's Print has no printf, so Log adds one.
#if !defined(BRINGUP_CONSOLE_TX) || !defined(BRINGUP_CONSOLE_RX)
#error "pins.h has no BRINGUP_CONSOLE_TX/RX: regenerate it for this chip (codegen/firmware.ts pinsHeader)"
#endif
static arduino::UART halUart(BRINGUP_CONSOLE_TX, BRINGUP_CONSOLE_RX);
struct Console : public Print {
	size_t write(uint8_t c) override { return halUart.write(c); }
	size_t write(const uint8_t *b, size_t n) override { return halUart.write(b, n); }
	void flush() override { halUart.flush(); }
	size_t printf(const char *fmt, ...) __attribute__((format(printf, 2, 3))) {
		char buf[192];
		va_list ap;
		va_start(ap, fmt);
		const int n = vsnprintf(buf, sizeof buf, fmt, ap);
		va_end(ap);
		return n <= 0 ? 0 : write((const uint8_t *)buf, (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1);
	}
};
static Console Log;
static void logBegin() { halUart.begin(115200); }

// The mbed linker script's .uninitialized_data: crt0 neither zeroes nor loads it, and halSleep ends in a watchdog
// reboot, which leaves SRAM as it was. Garbage after power-up, as on the STM32.
#define HAL_RETAINED __attribute__((section(".uninitialized_data")))
#define HAL_PIN_VALID(p) ((p) >= 0 && (p) < 30)

// The file store (HalFile, below the arch branches): mbed's LittleFileSystem on the top 128 KB of the 2 MB QSPI flash
// (the W25Q16JV the profile's board carries, as on the Pico), through FlashIAPBlockDevice (4 KB erase blocks). The
// image starts at the bottom of the same flash; it is about 100 KB.
#define HAL_FLASH_BYTES (2u * 1024u * 1024u)
#define HAL_FS_BYTES (128u * 1024u)
#define HAL_HISTORY_CHUNK 4096u  // one erase block per history file
static FlashIAPBlockDevice halBlockDevice(XIP_BASE + HAL_FLASH_BYTES - HAL_FS_BYTES, HAL_FS_BYTES);
static mbed::LittleFileSystem halFs(nullptr);
static int halFsUsers = 0;
static bool halFsMount(bool format) {
	if (halFsUsers > 0) return ++halFsUsers, true;
	int err = halFs.mount(&halBlockDevice);
	if (err && format) err = halFs.reformat(&halBlockDevice);
	if (err) return false;
	halFsUsers = 1;
	return true;
}
static void halFsUnmount() {
	if (halFsUsers > 0 && --halFsUsers == 0) halFs.unmount();
}
struct HalFile {
	mbed::File f;
	bool isOpen = false;
	bool open(const char *path, bool write) { return isOpen = f.open(&halFs, path, write ? (O_RDWR | O_CREAT) : O_RDONLY) == 0; }
	bool readAt(uint32_t pos, void *b, uint32_t n) { return isOpen && f.seek(pos, SEEK_SET) == (off_t)pos && f.read(b, n) == (ssize_t)n; }
	bool writeAt(uint32_t pos, const void *b, uint32_t n) { return isOpen && f.seek(pos, SEEK_SET) == (off_t)pos && f.write(b, n) == (ssize_t)n; }
	void close() {
		if (isOpen) f.close();
		isOpen = false;
	}
};

// Sleep: the RP2040's SLEEP state (datasheet §2.11.5.1, as pico-extras' sleep_goto_sleep_until does it). Clocks move
// to the 12 MHz crystal and both PLLs stop; the RTC, clocked from the crystal at 46875 Hz, is the only clock left
// running while the core waits (SLEEP_EN0/1 = clk_rtc only, SCB DEEPSLEEP); its alarm wakes the core through
// SEVONPEND, with every interrupt masked, so no handler runs. Then a watchdog reboot, so every wake starts again at
// setup() as on the ESP32 and the clocks come back as boot sets them. DORMANT (0.18 mA) would stop the crystal and the
// RTC with it: only a pin could wake it. A wake pin is read once a second (an RTC alarm a second): a button wakes it
// within a second if held that long; USB sense is a level and is always seen.
// The current is an estimate, not a measurement: below the 0.8-1.3 mA Raspberry Pi gives for its Pico board in sleep
// (Pico datasheet, "Popular use-case power consumption", which includes the board's regulator), above the chip's
// 0.18 mA DORMANT (RP2040 datasheet Table 637), since the crystal and the RTC run.
HAL_RETAINED static volatile int32_t halWakePin;
HAL_RETAINED static volatile uint32_t halWakeMagic;
static const uint32_t HAL_WAKE_MAGIC = 0x57414B45u;
static bool halRtcSleepUntil(uint32_t t) {
	// t: seconds since the RTC's origin (day 1, 00:00:00); up to 30 days.
	const uint32_t day = 1 + t / 86400, hour = t / 3600 % 24, min = t / 60 % 60, sec = t % 60;
	hw_clear_bits(&rtc_hw->irq_setup_0, RTC_IRQ_SETUP_0_MATCH_ENA_BITS);
	while (rtc_hw->irq_setup_0 & RTC_IRQ_SETUP_0_MATCH_ACTIVE_BITS) {}
	rtc_hw->irq_setup_0 = (day << RTC_IRQ_SETUP_0_DAY_LSB) | RTC_IRQ_SETUP_0_DAY_ENA_BITS;
	rtc_hw->irq_setup_1 = (hour << RTC_IRQ_SETUP_1_HOUR_LSB) | RTC_IRQ_SETUP_1_HOUR_ENA_BITS | (min << RTC_IRQ_SETUP_1_MIN_LSB) | RTC_IRQ_SETUP_1_MIN_ENA_BITS | (sec << RTC_IRQ_SETUP_1_SEC_LSB) | RTC_IRQ_SETUP_1_SEC_ENA_BITS;
	rtc_hw->inte = RTC_INTE_RTC_BITS;
	hw_set_bits(&rtc_hw->irq_setup_0, RTC_IRQ_SETUP_0_MATCH_ENA_BITS);
	NVIC->ICPR[0] = 1u << RTC_IRQ;
	clocks_hw->sleep_en0 = CLOCKS_SLEEP_EN0_CLK_RTC_RTC_BITS;
	clocks_hw->sleep_en1 = 0;
	scb_hw->scr |= M0PLUS_SCR_SLEEPDEEP_BITS | M0PLUS_SCR_SEVONPEND_BITS;
	while (!(rtc_hw->intr & RTC_INTR_RTC_BITS)) __wfe();
	clocks_hw->sleep_en0 = ~0u;
	clocks_hw->sleep_en1 = ~0u;
	scb_hw->scr &= ~M0PLUS_SCR_SLEEPDEEP_BITS;
	hw_clear_bits(&rtc_hw->irq_setup_0, RTC_IRQ_SETUP_0_MATCH_ENA_BITS);
	return true;
}
[[noreturn]] static void halSleep(uint32_t seconds, int wakeLowPin, int wakeHighPin) {
	Log.flush();
	halUart.end();
	if (wakeLowPin >= 0) pinMode(wakeLowPin, INPUT_PULLUP);
	if (wakeHighPin >= 0) pinMode(wakeHighPin, INPUT);
	(void)save_and_disable_interrupts();  // never restored: the sleep ends in a reboot
	NVIC->ICER[0] = ~0u;
	SysTick->CTRL = 0;
	// Run from the crystal, PLLs off (pico-extras sleep_run_from_xosc).
	clock_configure(clk_ref, CLOCKS_CLK_REF_CTRL_SRC_VALUE_XOSC_CLKSRC, 0, 12000000, 12000000);
	clock_configure(clk_sys, CLOCKS_CLK_SYS_CTRL_SRC_VALUE_CLK_REF, 0, 12000000, 12000000);
	clock_stop(clk_usb);
	clock_stop(clk_adc);
	clock_configure(clk_rtc, 0, CLOCKS_CLK_RTC_CTRL_AUXSRC_VALUE_XOSC_CLKSRC, 12000000, 46875);
	clock_configure(clk_peri, 0, CLOCKS_CLK_PERI_CTRL_AUXSRC_VALUE_CLK_SYS, 12000000, 12000000);
	pll_deinit(pll_sys);
	pll_deinit(pll_usb);
	_rtc_init();  // the pico SDK's rtc_init, renamed in the mbed core (mbed has its own)
	datetime_t origin = {2020, 1, 1, 3, 0, 0, 0};
	rtc_set_datetime(&origin);
	const uint32_t limit = seconds > 30u * 86400u ? 30u * 86400u : seconds;
	halWakePin = -1;
	halWakeMagic = HAL_WAKE_MAGIC;
	const bool pins = wakeLowPin >= 0 || wakeHighPin >= 0;
	for (uint32_t t = pins ? 1 : limit; t <= limit; t += pins ? 1 : limit) {
		halRtcSleepUntil(t);
		if (wakeLowPin >= 0 && !gpio_get(wakeLowPin)) {
			halWakePin = wakeLowPin;
			break;
		}
		if (wakeHighPin >= 0 && gpio_get(wakeHighPin)) {
			halWakePin = wakeHighPin;
			break;
		}
	}
	watchdog_reboot(0, 0, 0);
	for (;;) {}
}
// Whether this boot is the end of a sleep that the given pin cut short.
__attribute__((unused)) static bool halWokeByPin(int pin) { return halWakeMagic == HAL_WAKE_MAGIC && halWakePin == pin && watchdog_caused_reboot(); }

// The QSPI flash's 64-bit unique id (pico_unique_id reads the same). Read with interrupts off: the flash leaves XIP
// mode meanwhile. Read once.
static uint64_t halUniqueId() {
	static uint64_t id = 0;
	static bool read = false;
	if (!read) {
		uint8_t b[8];
		const uint32_t irq = save_and_disable_interrupts();
		flash_get_unique_id(b);
		restore_interrupts(irq);
		for (int i = 0; i < 8; i++) id = id << 8 | b[i];
		read = true;
	}
	return id;
}
// The ring oscillator's random bit (RP2040 datasheet §2.17.5), one per read, folded with the unique id: different per
// chip and boot. Not certified as a random source; Raspberry Pi doesn't claim it is one.
static uint32_t halRandom32() {
	uint32_t x = 0;
	for (int i = 0; i < 32; i++) {
		x = x << 1 | (rosc_hw->randombit & 1);
		for (volatile int d = 0; d < 8; d++) {}
	}
	return x ^ (uint32_t)halUniqueId() ^ micros();
}

// I2C on the design's pins: MbedI2C takes them at construction (the mbed core picks I2C0/I2C1 from its pin map), so the
// template's Wire is this one instead of the core's (which is on GPIO4/5 and never begun).
#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static arduino::MbedI2C halWire(PIN_I2C_SDA, PIN_I2C_SCL);
#define Wire halWire
static void halWireBegin() { Wire.begin(); }
#endif

#elif defined(ARDUINO_ARCH_NRF52)
// ---- nRF52 (Adafruit nRF52 Arduino core 1.7.0: PlatformIO nordicnrf52@11.0.0, board nrf52840_dk_adafruit) ----------
// Pins are numbered as the contract does: the core's pca10056 variant maps Arduino pin n to P0.n for n < 32 and to
// P1.(n-32) above (g_ADigitalPinMap is the identity), so pin 13 is P0.13 and pin 36 is P1.04. The core runs FreeRTOS;
// setup() runs in its loop task. The board's ldscript (nrf52840_s140_v6.ld) leaves the S140 SoftDevice's flash and RAM
// below the application, which starts at 0x26000.
#define HAL_ARCH "nrf52"
#include <InternalFileSystem.h>

// The console: UARTE0 (the core's Serial1) moved to the profile's pins, P0.06 TX / P0.08 RX (the nRF52840-DK's
// J-Link virtual COM port); pins.h gives them as BRINGUP_CONSOLE_TX/RX. 115200 8N1. Serial itself is USB.
#if !defined(BRINGUP_CONSOLE_TX) || !defined(BRINGUP_CONSOLE_RX)
#error "pins.h has no BRINGUP_CONSOLE_TX/RX: regenerate it for this chip (codegen/firmware.ts pinsHeader)"
#endif
static Uart &Log = Serial1;
static void logBegin() {
	Serial1.setPins(BRINGUP_CONSOLE_RX, BRINGUP_CONSOLE_TX);
	Serial1.begin(115200);
}

// The ldscript has no .noinit; this section is placed after .bss as an orphan and marked NOLOAD (nobits), so the
// startup code neither zeroes nor loads it. RAM keeps its contents through the soft reset that ends each sleep.
#define HAL_RETAINED __attribute__((section(".noinit.bringup,\"aw\",%nobits@")))
#define HAL_PIN_VALID(p) ((p) >= 0 && (p) < 48)

// The file store: Adafruit's InternalFS, LittleFS on the 28 KB the ldscript leaves between the application and the
// bootloader (0xED000, 7 pages, 128-byte blocks), shared with Bluefruit's bonds. Writes go through the SoftDevice when
// it runs. The history is split in files of 512 bytes: LittleFS rewrites a file from the written block to its end, so
// a write rewrites at most four blocks, not the whole history.
#define HAL_HISTORY_CHUNK 512u
static bool halFsMount(bool) { return InternalFS.begin(); }
static void halFsUnmount() {}
struct HalFile {
	Adafruit_LittleFS_Namespace::File f{InternalFS};
	bool open(const char *path, bool write) { return f.open(path, write ? Adafruit_LittleFS_Namespace::FILE_O_WRITE : Adafruit_LittleFS_Namespace::FILE_O_READ); }
	bool readAt(uint32_t pos, void *b, uint32_t n) { return f && f.seek(pos) && f.read(b, n) == (int)n; }
	bool writeAt(uint32_t pos, const void *b, uint32_t n) { return f && f.seek(pos) && f.write((const uint8_t *)b, n) == n; }
	void close() {
		if (f) f.close();
	}
};

// Sleep: System ON with everything stopped but the RTC. The core's FreeRTOS idles tickless (configUSE_TICKLESS_IDLE 1):
// delay() leaves the CPU in WFE (sd_app_evt_wait with the SoftDevice) until RTC1 wakes it, with the console UARTE and
// TWIM disabled first (an enabled UARTE receiver keeps the high-frequency clock on). Then a soft reset, so every wake
// starts again at setup() as on the ESP32. System OFF (0.4 µA) has no timer wake: only a pin or NFC could end it.
// Estimate: 3.16 µA (nRF52840 Product Specification v1.7, I_ON_RAMON_RTC: System ON, all 256 KB RAM retained, RTC
// running), plus the wake pins' polling: one 100 ms tick each, about 10 short wakes a second, a few µA more. Not
// measured. A wake pin is polled every 100 ms (GPIOTE IN events, which attachInterrupt uses, keep the HFCLK on).
HAL_RETAINED static volatile int32_t halWakePin;
HAL_RETAINED static volatile uint32_t halWakeMagic;
static const uint32_t HAL_WAKE_MAGIC = 0x57414B45u;
[[noreturn]] static void halSleep(uint32_t seconds, int wakeLowPin, int wakeHighPin) {
	Log.flush();
	Serial1.end();
#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
	Wire.end();
#endif
	if (wakeLowPin >= 0) pinMode(wakeLowPin, INPUT_PULLUP);
	if (wakeHighPin >= 0) pinMode(wakeHighPin, INPUT);
	halWakePin = -1;
	halWakeMagic = HAL_WAKE_MAGIC;
	const bool pins = wakeLowPin >= 0 || wakeHighPin >= 0;
	const uint32_t total = seconds * 1000UL, start = millis();
	for (;;) {
		const uint32_t gone = millis() - start;
		if (gone >= total) break;
		if (wakeLowPin >= 0 && digitalRead(wakeLowPin) == LOW) {
			halWakePin = wakeLowPin;
			break;
		}
		if (wakeHighPin >= 0 && digitalRead(wakeHighPin) == HIGH) {
			halWakePin = wakeHighPin;
			break;
		}
		const uint32_t left = total - gone;
		delay(pins && left > 100 ? 100 : left);
	}
	NVIC_SystemReset();
	for (;;) {}
}
// Whether this boot is the end of a sleep that the given pin cut short.
__attribute__((unused)) static bool halWokeByPin(int pin) { return halWakeMagic == HAL_WAKE_MAGIC && halWakePin == pin; }

// FICR DEVICEID: the 64-bit id Nordic writes into every chip.
static uint64_t halUniqueId() { return (uint64_t)NRF_FICR->DEVICEID[1] << 32 | NRF_FICR->DEVICEID[0]; }
// The RNG peripheral (thermal noise, bias correction on): through the SoftDevice when it runs (it owns the RNG then),
// directly otherwise.
static uint32_t halRandom32() {
	uint32_t x = 0;
	uint8_t en = 0;
	sd_softdevice_is_enabled(&en);
	if (en) {
		uint8_t avail = 0;
		while (avail < 4) sd_rand_application_bytes_available_get(&avail);
		sd_rand_application_vector_get((uint8_t *)&x, 4);
		return x;
	}
	NRF_RNG->CONFIG = 1;
	for (int i = 0; i < 4; i++) {
		NRF_RNG->EVENTS_VALRDY = 0;
		NRF_RNG->TASKS_START = 1;
		while (!NRF_RNG->EVENTS_VALRDY) {}
		x = x << 8 | (NRF_RNG->VALUE & 0xFF);
	}
	NRF_RNG->TASKS_STOP = 1;
	return x;
}

#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static void halWireBegin() {
	Wire.setPins(PIN_I2C_SDA, PIN_I2C_SCL);
	Wire.begin();
}
#endif

#else
#error "hal.h: unknown Arduino core (no ARDUINO_ARCH_ESP32 / _STM32 / _RP2040 / _NRF52)"
#endif

#if defined(HAL_HISTORY_CHUNK)
// ---- The file store's key-value store and history (RP2040, nRF52) -------------------------------------------------
// HalKv: HAL_KV_SLOTS slots of {FNV-1a hash of "namespace/key", value} in /kv.bin, read at begin and written back at
// end if changed (the STM32 branch's layout). LittleFS levels the wear itself.
// The history: slot n is the 4-byte word at (n * 4) % HAL_HISTORY_CHUNK of /h<n * 4 / HAL_HISTORY_CHUNK>.bin.
#ifndef HISTORY_BYTES
#define HISTORY_BYTES 4096
#endif
#define HAL_KV_SLOTS 8
static bool halHistoryMount(bool format) { return halFsMount(format); }
static void halHistoryUnmount() { halFsUnmount(); }
struct HalKv {
	const char *ns = "";
	uint32_t slot[HAL_KV_SLOTS][2];
	bool loaded = false, dirty = false;
	static uint32_t hash(const char *ns, const char *key) {
		uint32_t h = 2166136261u;
		for (const char *s = ns; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
		h = (h ^ '/') * 16777619u;
		for (const char *s = key; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
		return h == 0xFFFFFFFFu ? 0xFFFFFFFEu : h;
	}
	bool begin(const char *name, bool) {
		ns = name;
		memset(slot, 0xFF, sizeof slot);
		if (!halFsMount(true)) return false;
		loaded = true;
		HalFile f;
		if (f.open("/kv.bin", false)) {
			if (!f.readAt(0, slot, sizeof slot)) memset(slot, 0xFF, sizeof slot);
			f.close();
		}
		return true;
	}
	int find(uint32_t h, bool orFree) {
		for (int i = 0; i < HAL_KV_SLOTS; i++)
			if (slot[i][0] == h || (orFree && slot[i][0] == 0xFFFFFFFFu)) return i;
		return -1;
	}
	uint32_t get(const char *key, uint32_t def) {
		const int i = find(hash(ns, key), false);
		return i < 0 ? def : slot[i][1];
	}
	void put(const char *key, uint32_t value) {
		const uint32_t h = hash(ns, key);
		const int i = find(h, true);
		if (i < 0 || (slot[i][0] == h && slot[i][1] == value)) return;
		slot[i][0] = h;
		slot[i][1] = value;
		dirty = true;
	}
	void end() {
		if (!loaded) return;
		if (dirty) {
			HalFile f;
			if (f.open("/kv.bin", true)) {
				f.writeAt(0, slot, sizeof slot);
				f.close();
			}
		}
		dirty = loaded = false;
		halFsUnmount();
	}
};
struct HalHistory {
	HalFile f;
	int32_t chunk = -1;
	bool writable = false;
	bool open(bool write) {
		writable = write;
		chunk = -1;
		return true;
	}
	bool seekChunk(uint32_t c) {
		if ((int32_t)c == chunk) return true;
		f.close();
		char path[16];
		snprintf(path, sizeof path, "/h%03lu.bin", (unsigned long)c);
		chunk = f.open(path, writable) ? (int32_t)c : -1;
		return chunk >= 0;
	}
	bool read(uint32_t slot, uint32_t &record) {
		const uint32_t at = slot * sizeof(uint32_t);
		return at + sizeof record <= HISTORY_BYTES && seekChunk(at / HAL_HISTORY_CHUNK) && f.readAt(at % HAL_HISTORY_CHUNK, &record, sizeof record);
	}
	bool write(uint32_t slot, uint32_t record) {
		const uint32_t at = slot * sizeof(uint32_t);
		return writable && at + sizeof record <= HISTORY_BYTES && seekChunk(at / HAL_HISTORY_CHUNK) && f.writeAt(at % HAL_HISTORY_CHUNK, &record, sizeof record);
	}
	void close() {
		f.close();
		chunk = -1;
	}
};
#endif

// v with the given decimals (0..3) as text, rounded half away from zero, without printf's %f: "21.50", "-0.3".
static const char *halFixed(char *buf, size_t n, float v, int decimals) {
	static const long SCALE[] = {1, 10, 100, 1000};
	const long scale = SCALE[decimals < 0 ? 0 : decimals > 3 ? 3 : decimals];
	const long x = lroundf(fabsf(v) * scale);
	const char *sign = v < 0 && x != 0 ? "-" : "";
	if (scale == 1) snprintf(buf, n, "%s%ld", sign, x);
	else snprintf(buf, n, "%s%ld.%0*ld", sign, x / scale, decimals, x % scale);
	return buf;
}
