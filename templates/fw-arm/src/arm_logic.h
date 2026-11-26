// The arm's control logic in plain C (no Arduino): inverse kinematics, the move profile, the pick-and-place plan and the
// servo mapping. The board build, the simulation build and the host tests (test/arm-firmware.test.ts) run the same code.
// Angles in degrees, joints in ARM_JOINTS order (base-yaw, shoulder, elbow, wrist-pitch, wrist-roll), then the gripper.
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define ARM_NJ 5  // joints
#define ARM_NS 6  // servos: the joints, then the gripper

typedef struct {
	float yawOffMm;     // the shoulder axis's forward offset from the yaw axis (base-yaw linkMm)
	float shoulderZMm;  // the shoulder axis above the plate's top
	float l1, l2, l3;   // shoulder link, elbow link, wrist-pitch + wrist-roll (to the grip point)
	float minDeg[ARM_NJ], maxDeg[ARM_NJ];
} arm_geom;

// The joint angles that put the grip point at (x, y, z) mm with the gripper pointing straight down (src/arm/kinematics.ts
// solve, mirrored): 0 when solved; 1 out of reach (*shortMm: how far), 2 reachable but outside a joint's limits.
int arm_solve(const arm_geom *g, float x, float y, float z, float out[ARM_NJ], float *shortMm);
// The grip point for joint angles (for the tests and the log).
void arm_forward(const arm_geom *g, const float deg[ARM_NJ], float tip[3]);

// One synchronised move: every servo leaves `from` and reaches `to` together, each under its speed limit (deg/s), with a
// linear ramp of rampS at each end (a trapezoid).
typedef struct {
	float from[ARM_NS], to[ARM_NS];
	float durS, rampS;
} arm_move;
void arm_move_plan(arm_move *m, const float from[ARM_NS], const float to[ARM_NS], const float degPerS[ARM_NS], float rampS);
void arm_move_at(const arm_move *m, float tS, float out[ARM_NS]);

// The pick-and-place plan: waypoints (all six servos) and how long to hold each after reaching it.
typedef struct {
	float deg[ARM_NS];
	uint16_t holdMs;
} arm_waypoint;
typedef struct {
	arm_geom g;
	float pick[3], drop[3];
	float approachMm;           // how far above pick and drop the arm comes in (lowered until both solve)
	float gripOpenDeg, gripClosedDeg;
	uint16_t gripHoldMs;
	uint16_t settleMs;          // held at the pick and drop before the gripper moves: the servos catch up with the plan
} arm_task;
// Writes one cycle (8 waypoints) into out; returns the count, or -1 when pick or drop can't be solved even with no approach.
int arm_plan(const arm_task *t, arm_waypoint out[], int max, float *approachUsedMm);

// A servo's command: the joint's range centred in the servo's travel (the horn is fitted so), plus its calibration
// offset; then the pulse (us) and the PCA9685's four LEDn bytes (ON at 0, OFF at the pulse's count).
float arm_servo_deg(float jointDeg, float minDeg, float maxDeg, float rangeDeg, float calDeg);
uint16_t arm_pulse_us(float servoDeg, float rangeDeg, uint16_t us0, uint16_t us1);
uint8_t arm_pca_prescale(uint32_t hz);
uint16_t arm_pca_ticks(uint32_t us, uint32_t hz);
void arm_pca_bytes(uint16_t offTicks, uint8_t out[4]);
uint8_t arm_pca_reg(uint8_t ch);  // LEDn_ON_L

#ifdef __cplusplus
}
#endif
