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
	float lastHeading = NAN; // the gyro's heading at the last tick (NAN: no gyro)
	float lastDs = 0, lastDth = 0; // the last tick's travel (mm) and turn (rad): whether the robot is still
};

static inline float rover_wrap(float a) {
	while (a > (float)M_PI) a -= 2 * (float)M_PI;
	while (a < -(float)M_PI) a += 2 * (float)M_PI;
	return a;
}

// Each tick: the wheels' travel since the last one (counts x mm per count), the arc it makes, the pose moved along it.
// With a gyro (headingRad not NAN: an IMU on the board, hw_heading_rad) the turn comes from its heading, the distance
// from the wheels: wheels scrub on a turn in place, so their difference under-reads it (run 20b's S3 in simulation,
// 19 Nov 2026: 0.679 rad counted for 0.816 turned, a go-to 75 mm off); without one, from the wheels' difference.
inline void rover_odo_step(RoverOdo &o, int32_t encL, int32_t encR, float mmPerCount, float trackMm, float headingRad = NAN) {
	if (!o.started) {
		o.lastL = encL;
		o.lastR = encR;
		o.lastHeading = headingRad;
		o.started = true;
		return;
	}
	const float dl = (float)(encL - o.lastL) * mmPerCount, dr = (float)(encR - o.lastR) * mmPerCount;
	o.lastL = encL;
	o.lastR = encR;
	const bool gyro = !isnan(headingRad) && !isnan(o.lastHeading);
	const float ds = (dl + dr) / 2, dth = gyro ? rover_wrap(headingRad - o.lastHeading) : (dr - dl) / trackMm;
	o.lastHeading = headingRad;
	o.lastDs = ds;
	o.lastDth = dth;
	o.x += ds * cosf(o.th + dth / 2);
	o.y += ds * sinf(o.th + dth / 2);
	o.th = rover_wrap(o.th + dth);
}

struct RoverGoto {
	bool active = false;
	bool facing = false; // turned toward the target: driving to it
	bool done = false;
	float tx = 0, ty = 0;
	// Every change of manoeuvre waits for the robot to stand still (rover_goto_step): after the turn toward the target,
	// and on arrival. settle: 0 none, 1 after the turn, 2 after the stop at the target.
	int settle = 0, still = 0, tries = 0;
	float stopX = 0, stopY = 0, stopTh = 0;
	// How far it rolled on after a stop at the target, learned from the last one (kept across targets): the next approach
	// stops that much short.
	float coastMm = 0;
	// The same for turning in place: how far it kept rotating after the turn toward a target stopped (radians).
	float turnCoastRad = 0;
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
// Still: under 0.3 mm and 0.005 rad a tick for this many ticks. A correction after a stop: at most this many.
static const int GOTO_STILL_TICKS = 2;
// From rest, a heading within this is good enough to drive: the drive's heading hold takes the rest gently (at 4 deg its
// wheels differ by 10 %, no slip). A re-turn for every overshoot past GOTO_FACE_RAD cost each corner of run 20b's lap
// ~0.7 s of small turns and stops (25 Nov 2026).
static const float GOTO_ACCEPT_RAD = 0.07f;  // 4 degrees
static const int GOTO_TRIES = 3;

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
	g.settle = g.still = g.tries = 0;
}

// Starts the route's next point when the go-to is idle; false when none is left.
inline bool rover_route_next(RoverRoute &r, RoverGoto &g) {
	if (g.active || r.next >= r.n) return false;
	rover_goto_start(g, r.x[r.next], r.y[r.next]);
	r.next++;
	return true;
}

// cruise: the duty at cruise speed; minDuty: the least duty that keeps it moving.
// Each change of manoeuvre starts from rest: the turn toward the target ends, the robot stops, and only then is the
// heading checked again and the drive begun; the drive ends, the robot stops, and only then is the distance checked
// again. Run 20b's S3 in simulation turned 11 deg past the target's bearing and set off on a hard correcting arc while
// still rotating: its wheels slipped, the odometry counted 29 mm that weren't driven, and it ended 21.8 mm from (400,
// 400) (20 Nov 2026). It also rolled 13-15 mm on after each stop; the coast is learned and the next stop comes earlier.
inline RoverOut rover_goto_step(RoverGoto &g, const RoverOdo &o, float cruise, float minDuty) {
	if (!g.active) return RoverOut{0, 0};
	if (g.settle) {
		const bool moving = fabsf(o.lastDs) > 0.3f || fabsf(o.lastDth) > 0.005f;  // under ~9 mm/s and ~9 deg/s: at rest for slip
		g.still = moving ? 0 : g.still + 1;
		if (g.still < GOTO_STILL_TICKS) return RoverOut{0, 0};
		const int was = g.settle;
		g.settle = g.still = 0;
		if (was == 2) {
			const float rolled = hypotf(o.x - g.stopX, o.y - g.stopY);
			g.coastMm = g.coastMm > 0 ? 0.5f * (g.coastMm + rolled) : rolled;
			const float dist = rover_goto_remaining(g, o);
			const float err = rover_wrap(atan2f(g.ty - o.y, g.tx - o.x) - o.th);
			// There, out of corrections, or past it: done where it stands.
			if (dist < ROVER_GOTO_TOL_MM || ++g.tries > GOTO_TRIES || fabsf(err) > (float)M_PI / 2) {
				g.active = false;
				g.done = true;
				return RoverOut{0, 0};
			}
			g.facing = false;  // short of it: face it again from here and creep the rest
		} else {
			const float rolled = fabsf(rover_wrap(o.th - g.stopTh));
			g.turnCoastRad = g.turnCoastRad > 0 ? 0.5f * (g.turnCoastRad + rolled) : rolled;
			const float err = rover_wrap(atan2f(g.ty - o.y, g.tx - o.x) - o.th);
			if (fabsf(err) >= GOTO_ACCEPT_RAD && ++g.tries <= GOTO_TRIES) g.facing = false;
			else g.tries = 0;
		}
	}
	const float dist = rover_goto_remaining(g, o);
	const float err = rover_wrap(atan2f(g.ty - o.y, g.tx - o.x) - o.th);
	// Arrived (with a learned coast: where rolling on ends it in the tolerance's middle, not at its edge), or passed it (it is behind, close): stop, then check from rest.
	if (dist < (g.facing && g.coastMm > 0 ? g.coastMm + 0.5f * ROVER_GOTO_TOL_MM : ROVER_GOTO_TOL_MM) || (g.facing && dist < 2 * ROVER_GOTO_TOL_MM && fabsf(err) > (float)M_PI / 2)) {
		g.settle = 2;
		g.stopX = o.x;
		g.stopY = o.y;
		return RoverOut{0, 0};
	}
	if (g.facing && fabsf(err) > GOTO_REFACE_RAD && dist > GOTO_SLOW_MM) g.facing = false;
	if (!g.facing) {
		// Faced it, less the rotation it will carry on with (learned): stop turning, and look again from rest.
		if (fabsf(err) < GOTO_FACE_RAD + fminf(g.turnCoastRad, 0.3f)) {
			g.facing = true;
			g.settle = 1;
			g.stopTh = o.th;  // faced it: stop turning, and look again from rest
			return RoverOut{0, 0};
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
