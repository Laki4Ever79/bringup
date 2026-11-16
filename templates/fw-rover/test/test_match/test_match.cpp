// The match's start and end on the host: pio test -e native (Eurobot General Rules 1.2 F.6, H.3).
#include <unity.h>
#include "../../src/match.h"

static const uint32_t MATCH = 100000;

void setUp(void) {}
void tearDown(void) {}

void test_powered_up_without_the_cord_it_never_starts(void) {
	MatchState st;
	for (uint32_t t = 0; t < 5000; t += 10) TEST_ASSERT_FALSE(match_step(st, false, t, MATCH));
	TEST_ASSERT_EQUAL(MATCH_WAIT_CORD, st.phase);
}

void test_it_arms_with_the_cord_in_and_starts_once_it_is_pulled(void) {
	MatchState st;
	TEST_ASSERT_FALSE(match_step(st, true, 0, MATCH));
	TEST_ASSERT_FALSE(match_step(st, true, 1000, MATCH));
	TEST_ASSERT_FALSE(match_step(st, false, 2000, MATCH));  // pulled: the debounce runs
	TEST_ASSERT_FALSE(match_step(st, false, 2030, MATCH));
	TEST_ASSERT_TRUE(match_step(st, false, 2050, MATCH));   // out for 50 ms: go
	TEST_ASSERT_EQUAL(MATCH_RUNNING, st.phase);
}

void test_a_bounce_of_the_plug_does_not_start_it(void) {
	MatchState st;
	match_step(st, true, 0, MATCH);
	TEST_ASSERT_FALSE(match_step(st, false, 100, MATCH));
	TEST_ASSERT_FALSE(match_step(st, true, 120, MATCH));    // back in after 20 ms
	TEST_ASSERT_FALSE(match_step(st, false, 140, MATCH));
	TEST_ASSERT_FALSE(match_step(st, false, 180, MATCH));   // 40 ms out since the bounce
	TEST_ASSERT_TRUE(match_step(st, false, 190, MATCH));
}

void test_it_stops_for_good_after_the_match(void) {
	MatchState st;
	match_step(st, true, 0, MATCH);
	match_step(st, false, 10, MATCH);
	TEST_ASSERT_TRUE(match_step(st, false, 60, MATCH));
	TEST_ASSERT_TRUE(match_step(st, false, 60 + MATCH - 1, MATCH));
	TEST_ASSERT_FALSE(match_step(st, false, 60 + MATCH, MATCH));
	// Plugging the cord back in or the clock wrapping doesn't restart it: a reset does.
	TEST_ASSERT_FALSE(match_step(st, true, 60 + MATCH + 10, MATCH));
	TEST_ASSERT_FALSE(match_step(st, false, 60 + MATCH + 1000, MATCH));
	TEST_ASSERT_EQUAL(MATCH_OVER, st.phase);
}

int main(int, char **) {
	UNITY_BEGIN();
	RUN_TEST(test_powered_up_without_the_cord_it_never_starts);
	RUN_TEST(test_it_arms_with_the_cord_in_and_starts_once_it_is_pulled);
	RUN_TEST(test_a_bounce_of_the_plug_does_not_start_it);
	RUN_TEST(test_it_stops_for_good_after_the_match);
	return UNITY_END();
}
