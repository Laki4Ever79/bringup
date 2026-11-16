// The rover's control logic on the host: pio test -e native
#include <unity.h>
#include "../../src/rover.h"

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
static const RoverConfig ENC = {200, 500, 0.6f, 600, 300, 0.001f};

void test_with_encoders_the_turn_ends_on_the_counts(void) {
	RoverState st;
	RoverOut o = rover_step(ENC, st, 150, 0, 1000, 1000);  // a wall: the turn begins
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_step(ENC, st, -1, 100, 1200, 800);  // 200 counts each: still turning
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_step(ENC, st, -1, 200, 1300, 700);  // 300 counts each: done, though the 600 ms haven't passed
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.left);
	TEST_ASSERT_EQUAL_FLOAT(0.6f, o.right);
}

void test_with_encoders_a_stalled_turn_still_ends_on_the_time_limit(void) {
	RoverState st;
	rover_step(ENC, st, 150, 0, 0, 0);
	RoverOut o = rover_step(ENC, st, -1, 1199, 10, -10);
	TEST_ASSERT_TRUE(o.left > 0 && o.right < 0);
	o = rover_step(ENC, st, -1, 1200, 10, -10);  // twice turnMs: the fail-safe ends it
	TEST_ASSERT_TRUE(o.left > 0 && o.right > 0);
}

void test_with_encoders_the_straight_steers_back_toward_the_slower_wheel(void) {
	RoverState st;
	rover_step(ENC, st, -1, 0, 0, 0);
	RoverOut o = rover_step(ENC, st, -1, 100, 150, 100);  // the left wheel ran 50 counts ahead: the rover veers right
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.55f, o.left);
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.65f, o.right);
	o = rover_step(ENC, st, -1, 200, 1000, 0);  // a large error: the correction stops at a fifth of the duty
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.48f, o.left);
	TEST_ASSERT_FLOAT_WITHIN(1e-4f, 0.72f, o.right);
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
	return UNITY_END();
}
