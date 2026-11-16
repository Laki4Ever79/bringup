// Odometry and go-to-point on the wheel encoders. Pure, no hardware calls: the board, QEMU and the native test run it.
// Built in only when hw_pins.h defines ROVER_ENC_COUNTS_PER_REV (an encoder gearmotor), so a rover without encoders
// builds as before.
//
// Pose: x, y in mm and th in radians from where the rover was when it started counting, x straight ahead, y to its left,
// th counter-clockwise; the point tracked is the middle of the drive axle.
#pragma once
#include <math.h>
#include <stdint.h>
#include "rover.h"  // RoverOut

struct RoverOdo {
	float x = 0, y = 0, th = 0;
	int32_t lastL = 0, lastR = 0;
	bool started = false;
};

static inline float rover_wrap(float a) {
	while (a > (float)M_PI) a -= 2 * (float)M_PI;
	while (a < -(float)M_PI) a += 2 * (float)M_PI;
	return a;
}

// Each tick: the wheels' travel since the last one (counts x mm per count), the arc it makes, the pose moved along it.
inline void rover_odo_step(RoverOdo &o, int32_t encL, int32_t encR, float mmPerCount, float trackMm) {
	if (!o.started) {
		o.lastL = encL;
		o.lastR = encR;
		o.started = true;
		return;
	}
	const float dl = (float)(encL - o.lastL) * mmPerCount, dr = (float)(encR - o.lastR) * mmPerCount;
	o.lastL = encL;
	o.lastR = encR;
	const float ds = (dl + dr) / 2, dth = (dr - dl) / trackMm;
	o.x += ds * cosf(o.th + dth / 2);
	o.y += ds * sinf(o.th + dth / 2);
	o.th = rover_wrap(o.th + dth);
}

struct RoverGoto {
	bool active = false;
	bool facing = false; // turned toward the target: driving to it
	bool done = false;
	float tx = 0, ty = 0;
};

// The design choices of the go-to controller: within ROVER_GOTO_TOL_MM it has arrived; it turns in place until it faces
// the target within GOTO_FACE_RAD, turns in place again if the heading drifts past GOTO_REFACE_RAD while far off, and
// slows linearly over the last GOTO_SLOW_MM, never under minDuty (enough to keep the wheels turning).
#ifndef ROVER_GOTO_TOL_MM
#define ROVER_GOTO_TOL_MM 8.0f
#endif
static const float GOTO_FACE_RAD = 0.035f;   // 2 degrees
static const float GOTO_REFACE_RAD = 0.35f;  // 20 degrees
static const float GOTO_SLOW_MM = 150.0f;

// A route: the points to drive to in turn (a lap: a rectangle's corners and back to the start), the odometry carried
// throughout. rover_route_next starts the next one when the go-to is done; false when the route is over.
static const int ROUTE_MAX = 16;
struct RoverRoute {
	float x[ROUTE_MAX], y[ROUTE_MAX];
	int n = 0, next = 0;
};
inline bool rover_route_add(RoverRoute &r, float xMm, float yMm) {
	if (r.n >= ROUTE_MAX) return false;
	r.x[r.n] = xMm;
	r.y[r.n] = yMm;
	r.n++;
	return true;
}
inline void rover_route_clear(RoverRoute &r) { r.n = r.next = 0; }

inline float rover_goto_remaining(const RoverGoto &g, const RoverOdo &o) { return hypotf(g.tx - o.x, g.ty - o.y); }

inline void rover_goto_start(RoverGoto &g, float xMm, float yMm) {
	g.active = true;
	g.facing = false;
	g.done = false;
	g.tx = xMm;
	g.ty = yMm;
}

// Starts the route's next point when the go-to is idle; false when none is left.
inline bool rover_route_next(RoverRoute &r, RoverGoto &g) {
	if (g.active || r.next >= r.n) return false;
	rover_goto_start(g, r.x[r.next], r.y[r.next]);
	r.next++;
	return true;
}

// cruise: the duty at cruise speed; minDuty: the least duty that keeps it moving.
inline RoverOut rover_goto_step(RoverGoto &g, const RoverOdo &o, float cruise, float minDuty) {
	if (!g.active) return RoverOut{0, 0};
	const float dist = rover_goto_remaining(g, o);
	const float err = rover_wrap(atan2f(g.ty - o.y, g.tx - o.x) - o.th);
	// Arrived, or passed it (it is behind, close): stop there.
	if (dist < ROVER_GOTO_TOL_MM || (g.facing && dist < 2 * ROVER_GOTO_TOL_MM && fabsf(err) > (float)M_PI / 2)) {
		g.active = false;
		g.done = true;
		return RoverOut{0, 0};
	}
	if (g.facing && fabsf(err) > GOTO_REFACE_RAD && dist > GOTO_SLOW_MM) g.facing = false;
	if (!g.facing) {
		if (fabsf(err) < GOTO_FACE_RAD) {
			g.facing = true;
		} else {
			// In place, toward it: slower as the error closes.
			float u = cruise * fminf(1.0f, fabsf(err) / 0.5f);
			if (u < minDuty) u = minDuty;
			return err > 0 ? RoverOut{-u, u} : RoverOut{u, -u};
		}
	}
	float v = cruise * fminf(1.0f, dist / GOTO_SLOW_MM);
	if (v < minDuty) v = minDuty;
	// Heading held on the way: the wheels differ by a share of the speed in proportion to the error.
	float w = 1.5f * err * v;
	if (w > 0.5f * v) w = 0.5f * v;
	if (w < -0.5f * v) w = -0.5f * v;
	return RoverOut{v - w, v + w};
}
