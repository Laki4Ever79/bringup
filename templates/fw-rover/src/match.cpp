#include "match.h"

bool match_step(MatchState &st, bool cordIn, uint32_t nowMs, uint32_t matchMs) {
	switch (st.phase) {
	case MATCH_WAIT_CORD:
		if (cordIn) st.phase = MATCH_ARMED;
		return false;
	case MATCH_ARMED:
		if (cordIn) {
			st.out = false;
			return false;
		}
		if (!st.out) {
			st.out = true;
			st.outSince = nowMs;
		}
		if ((uint32_t)(nowMs - st.outSince) < MATCH_DEBOUNCE_MS) return false;
		st.phase = MATCH_RUNNING;
		st.startedAt = nowMs;
		// fall through: the first running tick drives
	case MATCH_RUNNING:
		if ((uint32_t)(nowMs - st.startedAt) >= matchMs) {
			st.phase = MATCH_OVER;
			return false;
		}
		return true;
	case MATCH_OVER:
	default:
		return false;
	}
}
