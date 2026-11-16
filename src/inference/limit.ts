// A model provider refusing every call until a reset (the Claude subscription's 5-hour limit, an API's quota or rate
// limit), told apart from one failed call: a run can't go on without its models, so it stops and says so (rover run
// cc-eurobot-10, 16 Nov 2026: from 03:47 every call failed with "You've hit your 5-hour limit", the agents went quiet,
// and the run reported 11 open problems as if the design had stopped there).
export function modelLimitOf(error: string): string | null {
	const result = /"result":"([^"]*limit[^"]*)"/i.exec(error)?.[1]
	if (result) return result
	if (/"api_error_status":429|\b429\b.*(quota|rate.?limit|limit)|insufficient_quota|usage limit/i.test(error)) return "the model provider refused the call (429: limit or quota)"
	return null
}
