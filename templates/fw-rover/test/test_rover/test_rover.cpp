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

int main(int, char **) {
	UNITY_BEGIN();
	RUN_TEST(test_no_reading_means_nothing_ahead);
	RUN_TEST(test_a_wall_inside_the_stop_distance_turns_it_away_for_the_turn_time);
	RUN_TEST(test_losing_the_reading_while_close_turns_it_away_instead_of_cruising_on);
	RUN_TEST(test_losing_the_reading_while_far_keeps_cruising);
	RUN_TEST(test_it_slows_down_approaching_a_wall);
	return UNITY_END();
}
