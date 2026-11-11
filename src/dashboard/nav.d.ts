export interface NavOptions {
	section: "home" | "designs" | "docs"
	trail?: { label: string; href?: string }[]
	levels?: { overview: string; boards: { name: string; href: string }[]; on: string | null } | null
}
export function navHtml(opts: NavOptions): string
export function mountNav(opts: NavOptions): HTMLElement
