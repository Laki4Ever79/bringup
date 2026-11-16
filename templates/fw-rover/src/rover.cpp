#include "rover.h"

RoverOut rover_step(const RoverConfig &cfg, RoverState &st, int distanceMm, uint32_t nowMs) {
	if (st.turning && (int32_t)(nowMs - st.turnUntil) < 0) return {cfg.cruise, -cfg.cruise};
	st.turning = false;
	// No reading right after a close one: too close to measure, not gone (rover.h). Otherwise nothing ahead in range.
	const bool tooClose = distanceMm < 0 && st.lastMm >= 0 && st.lastMm < cfg.slowMm;
	if (distanceMm < 0 && !tooClose) return {cfg.cruise, cfg.cruise};
	if (tooClose || distanceMm < cfg.stopMm) {
		st.turning = true;
		st.turnUntil = nowMs + cfg.turnMs;
		st.lastMm = -1;
		return {cfg.cruise, -cfg.cruise};
	}
	st.lastMm = distanceMm;
	if (distanceMm < cfg.slowMm) {
		float k = (float)(distanceMm - cfg.stopMm) / (float)(cfg.slowMm - cfg.stopMm);
		float d = cfg.cruise * (0.4f + 0.6f * k);
		return {d, d};
	}
	return {cfg.cruise, cfg.cruise};
}
