// Messages over CAN as Cyphal/CAN v1.0 (OpenCyphal, an open specification with MIT-licensed tools; 17 Nov 2026, before:
// the definition hash as the identifier and our own frame). Each message is a single-frame message transfer:
//   29-bit identifier: priority (bits 28-26), 0 for a message (25), 0 not anonymous (24), 0 reserved (23), 1 1 reserved
//   (22-21), the subject-ID (20-8), 0 reserved (7), the source node-ID (6-0) [Cyphal v1.0 §4.2.1];
//   data: the payload as DSDL serializes it (the fields little-endian, packed, in order: what a packed C struct holds on a
//   little-endian MCU) and a tail byte: start of transfer, end of transfer, toggle 1 and the transfer-ID mod 32.
// A classic CAN frame carries 8 bytes, so a payload of 7 at most (the spec check holds messages to it). yakut or
// pycyphal read the bus with the .dsdl files the firmware build writes beside it.
#pragma once
#include <stdint.h>

static const uint8_t LINK_CYPHAL_PRIORITY_NOMINAL = 4;
static const uint8_t LINK_CYPHAL_MAX_PAYLOAD = 7;

static inline uint32_t linkCyphalId(uint8_t priority, uint16_t subject, uint8_t node) {
	return (uint32_t)(priority & 7u) << 26 | 3ul << 21 | (uint32_t)(subject & 0x1FFFu) << 8 | (node & 0x7Fu);
}

// A single frame's tail byte: start, end and toggle set, the transfer-ID in the low five bits.
static inline uint8_t linkCyphalTail(uint8_t transferId) { return (uint8_t)(0xE0u | (transferId & 0x1Fu)); }

// True when an extended identifier is a Cyphal message frame (not a service, not anonymous, bit 23 and bit 7 clear) and
// the frame's last byte closes a single-frame transfer; then subject and node say what it is and who sent it.
static inline bool linkCyphalMessage(uint32_t id, const uint8_t *data, uint8_t len, uint16_t &subject, uint8_t &node) {
	if (len < 1 || (id & (1ul << 25)) || (id & (1ul << 24)) || (id & (1ul << 23)) || (id & (1ul << 7))) return false;
	const uint8_t tail = data[len - 1];
	if ((tail & 0xE0u) != 0xE0u) return false; // a multi-frame transfer: not one of ours
	subject = (uint16_t)((id >> 8) & 0x1FFFu);
	node = (uint8_t)(id & 0x7Fu);
	return true;
}
