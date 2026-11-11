// The one bar on every dashboard page (the page map, 11 Nov): Home · Designs · Docs, the section you're in marked, the
// trail of where you are, and inside a design its levels: Overview, then its boards.
import { test } from "node:test"
import assert from "node:assert/strict"
import { navHtml } from "../src/dashboard/nav.js"

test("the bar has the same three places everywhere, and marks the one you're in", () => {
	const h = navHtml({ section: "designs" })
	assert.match(h, /href="\/"[^>]*>Home</)
	assert.match(h, /href="\/designs"[^>]*aria-current="page"[^>]*>Designs</)
	assert.match(h, /href="https:\/\/github\.com\/Laki4Ever79\/bringup#readme"[^>]*>Docs</)
	assert.doesNotMatch(navHtml({ section: "home" }), /href="\/designs"[^>]*aria-current/)
})

test("the trail says where you are, each step but the last a link back up", () => {
	const h = navHtml({ section: "designs", trail: [{ label: "Designs", href: "/designs" }, { label: "logger & beacon", href: "/system?id=s" }, { label: "logger" }] })
	assert.match(h, /<a href="\/system\?id=s">logger &amp; beacon<\/a>/)
	assert.match(h, /<b>logger<\/b>/)
})

test("inside a design: Overview, then its boards after a divider, the open one marked", () => {
	const h = navHtml({ section: "designs", levels: { overview: "/system?id=s", boards: [{ name: "logger", href: "/system?id=s&board=logger" }, { name: "beacon", href: "/system?id=s&board=beacon" }], on: "beacon" } })
	assert.match(h, /href="\/system\?id=s"[^>]*>Overview</)
	assert.match(h, /class="nv-sep"[\s\S]*Boards[\s\S]*logger[\s\S]*beacon/)
	assert.match(h, /href="\/system\?id=s&amp;board=beacon"[^>]*aria-current="page"[^>]*>beacon</)
	assert.match(navHtml({ section: "designs", levels: { overview: "/x", boards: [{ name: "main", href: "/y" }], on: null } }), /Board</, "one board: 'Board', not 'Boards'")
})
