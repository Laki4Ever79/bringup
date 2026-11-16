#include "rover_enc.h"

static int32_t iabs(int32_t x) { return x < 0 ? -x : x; }

// Hold the straight: the wheels' count difference since the straight began is a heading error; a duty correction,
// limited to a fifth of the duty, turns it back (without encoders both stay at duty).
static RoverOut straight(const RoverEncConfig &cfg, const RoverEncState &st, float duty, int32_t encL, int32_t encR) {
	if (cfg.turnCounts <= 0) return {duty, duty};
	const int32_t err = (encL - st.straightL) - (encR - st.straightR);
	float c = cfg.holdGain * (float)err;
	const float lim = 0.2f * duty;
	if (c > lim) c = lim;
	if (c < -lim) c = -lim;
	return {duty - c, duty + c};
}

static void startTurn(const RoverEncConfig &cfg, RoverEncState &st, uint32_t nowMs, int32_t encL, int32_t encR) {
	st.backing = false;
	st.turning = true;
	st.turnUntil = nowMs + (cfg.turnCounts > 0 ? 2 * cfg.turnMs : cfg.turnMs);
	st.turnL = encL;
	st.turnR = encR;
}

RoverOut rover_enc_step(const RoverEncConfig &cfg, RoverEncState &st, int distanceMm, uint32_t nowMs, int32_t encL, int32_t encR) {
	if (st.backing) {
		// Back off until each wheel has run backCounts back on average (the turn time as a fail-safe), then turn.
		const bool timeLeft = (int32_t)(nowMs - st.turnUntil) < 0;
		if (timeLeft && (iabs(encL - st.turnL) + iabs(encR - st.turnR)) / 2 < cfg.backCounts) return {-cfg.cruise, -cfg.cruise};
		startTurn(cfg, st, nowMs, encL, encR);
		return {cfg.cruise, -cfg.cruise};
	}
	if (st.turning) {
		const bool timeLeft = (int32_t)(nowMs - st.turnUntil) < 0;
		// With encoders: until each wheel has turned turnCounts on average (the time limit as a fail-safe).
		const bool more = cfg.turnCounts > 0 ? (iabs(encL - st.turnL) + iabs(encR - st.turnR)) / 2 < cfg.turnCounts : true;
		if (timeLeft && more) return {cfg.cruise, -cfg.cruise};
		st.turning = false;
		st.straightL = encL;
		st.straightR = encR;
	}
	// No reading right after a close one: too close to measure, not gone (rover.h). Otherwise nothing ahead in range.
	const bool tooClose = distanceMm < 0 && st.lastMm >= 0 && st.lastMm < cfg.slowMm;
	if (distanceMm < 0 && !tooClose) return straight(cfg, st, cfg.cruise, encL, encR);
	if (tooClose || distanceMm < cfg.stopMm) {
		st.lastMm = -1;
		if (cfg.turnCounts > 0 && cfg.backCounts > 0) {
			st.backing = true;
			st.turnUntil = nowMs + cfg.turnMs;
			st.turnL = encL;
			st.turnR = encR;
			return {-cfg.cruise, -cfg.cruise};
		}
		startTurn(cfg, st, nowMs, encL, encR);
		return {cfg.cruise, -cfg.cruise};
	}
	st.lastMm = distanceMm;
	if (distanceMm < cfg.slowMm) {
		float k = (float)(distanceMm - cfg.stopMm) / (float)(cfg.slowMm - cfg.stopMm);
		return straight(cfg, st, cfg.cruise * (0.4f + 0.6f * k), encL, encR);
	}
	return straight(cfg, st, cfg.cruise, encL, encR);
}
