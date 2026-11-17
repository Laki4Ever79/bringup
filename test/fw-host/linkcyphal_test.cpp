// Runs linkcyphal.h on the host against the Cyphal/CAN v1.0 specification: one line per case, PASS <name> or FAIL <name>;
// exit code = failures.
#include <stdio.h>
#include "linkcyphal.h"

static int failures = 0;
static void check(const char *name, bool ok) {
	printf(ok ? "PASS %s\n" : "FAIL %s\n", name);
	if (!ok) failures++;
}

int main() {
	// uavcan.node.Heartbeat (fixed subject-ID 7509) from node 42 at nominal priority: 0x107D552A, the identifier every
	// Cyphal tool shows for it.
	check("heartbeat-id", linkCyphalId(LINK_CYPHAL_PRIORITY_NOMINAL, 7509, 42) == 0x107D552Aul);
	check("tail", linkCyphalTail(0) == 0xE0 && linkCyphalTail(31) == 0xFF && linkCyphalTail(33) == 0xE1);
	{
		const uint8_t data[] = {0x66, 0x08, 0xB9, 0x0F, 0xE5};
		uint16_t subject = 0;
		uint8_t node = 0;
		check("parse", linkCyphalMessage(linkCyphalId(4, 1234, 3), data, sizeof data, subject, node) && subject == 1234 && node == 3);
		// A service frame, an anonymous one, and a multi-frame transfer's first frame are not ours.
		const uint8_t first[] = {1, 2, 3, 4, 5, 6, 7, 0xA0};
		check("not-ours", !linkCyphalMessage(linkCyphalId(4, 1234, 3) | 1ul << 25, data, sizeof data, subject, node) && !linkCyphalMessage(linkCyphalId(4, 1234, 3) | 1ul << 24, data, sizeof data, subject, node) &&
			!linkCyphalMessage(linkCyphalId(4, 1234, 3), first, sizeof first, subject, node) && !linkCyphalMessage(linkCyphalId(4, 1234, 3), data, 0, subject, node));
	}
	return failures;
}
