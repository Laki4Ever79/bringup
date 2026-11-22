// The rover's control logic on the host: pio test -e native
#include <unity.h>
#include "../../src/rover.h"
#include "../../src/rover_enc.h"
#include "../../src/rover_quad.h"
#include "../../src/rover_odo.h"

static const RoverConfig CFG = {200, 500, 0.6f, 600};

void setUp(void) {}
void tearDown(void) {}

void test_no_reading_means_nothing_ahead(void) {
	RoverState st;
	RoverOut o = rover_step(CFG, st, -1, 0);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.right);
}

// The VL53L0X can't measure under about 30 mm: an obstacle that close may read as "nothing in range". So no reading
// right after a close one means it got too close to see, not that it went away: turn away (fail-safe).
void test_losing_the_reading_while_close_turns_it_away_instead_of_cruising_on(void) {
	RoverState st;
	rover_step(CFG, st, 450, 0);
	rover_step(CFG, st, 300, 100);
	RoverOut o = rover_step(CFG, st, -1, 200);
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	// After the turn the view has changed: no reading means nothing ahead again.
	o = rover_step(CFG, st, -1, 900);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.right);
}

void test_losing_the_reading_while_far_keeps_cruising(void) {
	RoverState st;
	rover_step(CFG, st, 900, 0);
	RoverOut o = rover_step(CFG, st, -1, 100);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.right);
}

void test_a_wall_inside_the_stop_distance_turns_it_away_for_the_turn_time(void) {
	RoverState st;
	RoverOut o = rover_step(CFG, st, 199, 1000);
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_step(CFG, st, -1, 1500);
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_step(CFG, st, -1, 1600);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.right);
}

void test_it_slows_down_approaching_a_wall(void) {
	RoverState st;
	RoverOut far = rover_step(CFG, st, 499, 0);
	RoverOut near = rover_step(CFG, st, 250, 0);
	TEST_ASSERT_TRUE(near.left < far.left && near.left > 0);
}

// With wheel encoders (rover.h turnCounts, holdGain): the turn ends on the wheels' counts, not the clock, and a
// straight holds the wheels' count difference at zero.
static const RoverEncConfig ENC = {200, 500, 0.6f, 600, 300, 0.001f, 0};

void test_with_encoders_the_turn_ends_on_the_counts(void) {
	RoverEncState st;
	RoverOut o = rover_enc_step(ENC, st, 150, 0, 1000, 1000);  // a wall: the turn begins
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_enc_step(ENC, st, -1, 100, 1200, 800);  // 200 counts each: still turning
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_enc_step(ENC, st, -1, 200, 1300, 700);  // 300 counts each: done, though the 600 ms haven't passed
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.right);
}

void test_with_encoders_a_stalled_turn_still_ends_on_the_time_limit(void) {
	RoverEncState st;
	rover_enc_step(ENC, st, 150, 0, 0, 0);
	RoverOut o = rover_enc_step(ENC, st, -1, 1199, 10, -10);
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_enc_step(ENC, st, -1, 1200, 10, -10);  // twice turnMs: the fail-safe ends it
	TEST_ASSERT_TRUE(o.left > 0 && o.right > 0);
}

void test_with_encoders_the_straight_steers_back_toward_the_slower_wheel(void) {
	RoverEncState st;
	rover_enc_step(ENC, st, -1, 0, 0, 0);
	RoverOut o = rover_enc_step(ENC, st, -1, 100, 150, 100);  // the left wheel ran 50 counts ahead: the rover veers right
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.55f, o.left);
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.65f, o.right);
	o = rover_enc_step(ENC, st, -1, 200, 1000, 0);  // a large error: the correction stops at a fifth of the duty
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.48f, o.left);
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.72f, o.right);
}

// With backCounts: it first backs straight off that far, then turns.
void test_with_encoders_it_backs_off_before_the_turn(void) {
	static const RoverEncConfig BACK = {200, 500, 0.6f, 600, 300, 0.001f, 100};
	RoverEncState st;
	RoverOut o = rover_enc_step(BACK, st, 150, 0, 0, 0);
	TEST_ASSERT_TRUE(o.left < 0 && o.right < 0);
	o = rover_enc_step(BACK, st, -1, 100, -60, -60);  // 60 counts back: still backing
	TEST_ASSERT_TRUE(o.left < 0 && o.right < 0);
	o = rover_enc_step(BACK, st, -1, 200, -100, -100);  // 100 counts back: the turn begins
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_enc_step(BACK, st, -1, 300, 200, -400);  // 300 counts each since the turn began: done
	TEST_ASSERT_TRUE(o.left > 0 && o.right > 0);
}

// Quadrature (rover_quad.h): a full cycle of both channels one way counts 4, the other way -4; a skipped state counts 0.
static int32_t run(const uint8_t *seq, int n) {
	int32_t c = 0;
	for (int i = 1; i < n; i++) c += quad_delta(seq[i - 1], seq[i]);
	return c;
}
void test_quadrature_counts_four_per_cycle_each_way(void) {
	const uint8_t fwd[] = {0, 1, 3, 2, 0};
	const uint8_t back[] = {0, 2, 3, 1, 0};
	TEST_ASSERT_EQUAL_INT32(4, run(fwd, 5));
	TEST_ASSERT_EQUAL_INT32(-4, run(back, 5));
	TEST_ASSERT_EQUAL_INT8(0, quad_delta(0, 3));  // both channels changed: direction unknown
	TEST_ASSERT_EQUAL_INT8(0, quad_delta(2, 2));  // no change
}
// A back-and-forth jitter on one edge (a wheel resting on a transition) nets zero.
void test_quadrature_jitter_on_an_edge_nets_zero(void) {
	const uint8_t jitter[] = {1, 3, 1, 3, 1, 3, 1};
	TEST_ASSERT_EQUAL_INT32(0, run(jitter, 7));
}
// The sign is learned from the first drive: an encoder counting down while driven forward reads positive from then on.
void test_quadrature_sign_is_learned_from_the_first_drive(void) {
	QuadSign q;
	TEST_ASSERT_EQUAL_INT32(-5, quad_forward(q, -5, 0.6f));  // not enough counts yet: raw
	TEST_ASSERT_EQUAL_INT32(20, quad_forward(q, -20, 0.6f)); // learned: this encoder counts down going forward
	TEST_ASSERT_EQUAL_INT32(-30, quad_forward(q, 30, -0.6f)); // backing: negative
	QuadSign r;
	TEST_ASSERT_EQUAL_INT32(-20, quad_forward(r, -20, -0.6f)); // backing first, counting down: already forward-positive
	TEST_ASSERT_EQUAL_INT32(40, quad_forward(r, 40, 0.6f));
}

// With a gyro the turn ends on the heading, not the counts: the wheels slip in a turn in place.
void test_with_a_gyro_the_turn_ends_on_the_heading(void) {
	RoverEncConfig cfg = {200, 500, 0.6f, 600, 1000, 0.001f, 0, 2.3562f};
	RoverEncState st;
	RoverOut o = rover_enc_step(cfg, st, 150, 0, 0, 0, 0.0f);  // wall: the turn begins at heading 0
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.right);
	o = rover_enc_step(cfg, st, -1, 100, 2000, -2000, 1.0f);   // counts past turnCounts, heading short: still turning
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.right);
	o = rover_enc_step(cfg, st, -1, 200, 2100, -2100, 2.40f);  // heading past 3/8 of a turn: straight on
	TEST_ASSERT_EQUAL_FLOAT(o.left, o.right);
}
// A gyro and no encoders: the turn runs past its planned time until the heading has turned (twice the time as the
// fail-safe), not cut at the planned time as a timed turn is.
void test_with_a_gyro_and_no_encoders_the_turn_outlasts_its_planned_time(void) {
	RoverEncConfig cfg = {200, 500, 0.6f, 600, 0, 0.0f, 0, 2.3562f};
	RoverEncState st;
	rover_enc_step(cfg, st, 150, 0, 0, 0, 0.0f);                       // the turn begins
	RoverOut o = rover_enc_step(cfg, st, -1, 900, 0, 0, 1.3f);         // past the 600 ms plan, heading short: still turning
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.right);
	o = rover_enc_step(cfg, st, -1, 1000, 0, 0, 2.40f);                // the heading has turned: straight on
	TEST_ASSERT_EQUAL_FLOAT(o.left, o.right);
	RoverEncState st2;
	rover_enc_step(cfg, st2, 150, 0, 0, 0, 0.0f);
	o = rover_enc_step(cfg, st2, -1, 1300, 0, 0, 1.0f);                // past twice the plan: the fail-safe ends it
	TEST_ASSERT_EQUAL_FLOAT(o.left, o.right);
}
// Without encoders a timed back-off comes before the turn in place: backward for backMs at cruise, then the turn.
void test_without_encoders_it_backs_off_for_its_time_before_the_turn(void) {
	RoverEncConfig cfg = {200, 500, 0.6f, 600, 0, 0.0f, 0, 2.3562f, 330};
	RoverEncState st;
	RoverOut o = rover_enc_step(cfg, st, 150, 0, 0, 0, 0.0f);          // the wall: back off
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.right);
	o = rover_enc_step(cfg, st, -1, 300, 0, 0, 0.0f);                   // still within its 330 ms
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.right);
	o = rover_enc_step(cfg, st, -1, 340, 0, 0, 0.0f);                   // its time is up: the turn
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(-0.6f, o.right);
}
// No heading (NAN): the turn closes on the counts as before.
void test_without_a_heading_the_turn_ends_on_the_counts(void) {
	RoverEncConfig cfg = {200, 500, 0.6f, 600, 1000, 0.001f, 0, 2.3562f};
	RoverEncState st;
	rover_enc_step(cfg, st, 150, 0, 0, 0);
	RoverOut o = rover_enc_step(cfg, st, -1, 100, 1000, -1000);
	TEST_ASSERT_EQUAL_FLOAT(o.left, o.right);
}


// With a gyro the odometry's turn is the gyro's: a turn in place whose wheels scrub (they count only 80 % of the arc)
// still reads the full quarter turn; without one, the wheels' difference.
void test_with_a_gyro_the_odometry_turns_by_the_heading(void) {
	const float mm = 0.1f, track = 200.0f;
	const int32_t arc = (int32_t)(0.8f * (float)M_PI / 2 * track / 2 / mm);  // each wheel's counts for 80 % of a quarter turn
	RoverOdo g, e;
	rover_odo_step(g, 0, 0, mm, track, 0.0f);
	rover_odo_step(e, 0, 0, mm, track);
	rover_odo_step(g, -arc, arc, mm, track, (float)M_PI / 2);
	rover_odo_step(e, -arc, arc, mm, track);
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, (float)M_PI / 2, g.th);
	TEST_ASSERT_FLOAT_WITHIN(1e-3f, 0.8f * (float)M_PI / 2, e.th);
	// Straight after it: the distance from the wheels, along the gyro's heading.
	rover_odo_step(g, -arc + 1000, arc + 1000, mm, track, (float)M_PI / 2);
	TEST_ASSERT_FLOAT_WITHIN(1e-2f, 100.0f, g.y);
	TEST_ASSERT_FLOAT_WITHIN(1e-2f, 0.0f, g.x);
}

int main(int, char **) {
	UNITY_BEGIN();
	RUN_TEST(test_no_reading_means_nothing_ahead);
	RUN_TEST(test_a_wall_inside_the_stop_distance_turns_it_away_for_the_turn_time);
	RUN_TEST(test_losing_the_reading_while_close_turns_it_away_instead_of_cruising_on);
	RUN_TEST(test_losing_the_reading_while_far_keeps_cruising);
	RUN_TEST(test_it_slows_down_approaching_a_wall);
	RUN_TEST(test_with_encoders_the_turn_ends_on_the_counts);
	RUN_TEST(test_with_encoders_a_stalled_turn_still_ends_on_the_time_limit);
	RUN_TEST(test_with_encoders_the_straight_steers_back_toward_the_slower_wheel);
	RUN_TEST(test_with_encoders_it_backs_off_before_the_turn);
	RUN_TEST(test_quadrature_counts_four_per_cycle_each_way);
	RUN_TEST(test_with_a_gyro_the_turn_ends_on_the_heading);
	RUN_TEST(test_without_a_heading_the_turn_ends_on_the_counts);
	RUN_TEST(test_without_encoders_it_backs_off_for_its_time_before_the_turn);
	RUN_TEST(test_with_a_gyro_and_no_encoders_the_turn_outlasts_its_planned_time);
	RUN_TEST(test_quadrature_jitter_on_an_edge_nets_zero);
	RUN_TEST(test_quadrature_sign_is_learned_from_the_first_drive);
	RUN_TEST(test_with_a_gyro_the_odometry_turns_by_the_heading);
	return UNITY_END();
}
