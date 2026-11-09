#include "rover.h"

RoverOut rover_step(const RoverConfig &cfg, RoverState &st, int distanceMm, uint32_t nowMs) {
	if (st.turning && (int32_t)(nowMs - st.turnUntil) < 0) return {cfg.cruise, -cfg.cruise};
	st.turning = false;
	// No reading: nothing ahead within range, keep cruising.
	if (distanceMm < 0) return {cfg.cruise, cfg.cruise};
	if (distanceMm < cfg.stopMm) {
		st.turning = true;
		st.turnUntil = nowMs + cfg.turnMs;
		return {cfg.cruise, -cfg.cruise};
	}
	if (distanceMm < cfg.slowMm) {
		float k = (float)(distanceMm - cfg.stopMm) / (float)(cfg.slowMm - cfg.stopMm);
		float d = cfg.cruise * (0.4f + 0.6f * k);
		return {d, d};
	}
	return {cfg.cruise, cfg.cruise};
}
