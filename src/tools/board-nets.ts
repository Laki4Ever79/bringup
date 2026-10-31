// Net name -> "REF.pinLabel" ends, read from tscircuit's circuit.json. A port's `name` is its pinLabel
// (or pinN when unlabelled). Traces that join ports directly, with no named net, are ignored.
export function netsFromCircuitJson(elements: any[]): Record<string, string[]> {
	const byId = (type: string, key: string) => new Map(elements.filter((e) => e.type === type).map((e) => [e[key], e]))
	const components = byId("source_component", "source_component_id")
	const ports = byId("source_port", "source_port_id")
	const netNames = new Map<string, string>()
	const nets: Record<string, string[]> = {}

	for (const net of byId("source_net", "source_net_id").values()) {
		netNames.set(net.source_net_id, net.name)
		nets[net.name] = []
	}

	for (const trace of elements.filter((e) => e.type === "source_trace")) {
		for (const netId of trace.connected_source_net_ids ?? []) {
			const name = netNames.get(netId)
			if (name === undefined) continue
			for (const portId of trace.connected_source_port_ids ?? []) {
				const port = ports.get(portId)
				const ref = components.get(port?.source_component_id)?.name
				if (!port || !ref) continue
				const end = `${ref}.${port.name}`
				if (!nets[name].includes(end)) nets[name].push(end)
			}
		}
	}
	return nets
}

// Board-level drilled holes (the mounting holes) from tscircuit's circuit.json, moved from its board-centred frame to the contract's frame (from the
// board's bottom-left corner), the frame the enclosure places its standoffs in.
export function holesFromCircuitJson(elements: any[]): { xMm: number; yMm: number; diameterMm: number }[] {
	const board = elements.find((e) => e.type === "pcb_board")
	const [w, h] = [board?.width ?? 0, board?.height ?? 0]
	return elements
		.filter((e) => e.type === "pcb_hole" && !e.pcb_component_id) // footprint holes (USB-C pegs) belong to their part
		.map((e) => ({ xMm: +(e.x + w / 2).toFixed(3), yMm: +(e.y + h / 2).toFixed(3), diameterMm: e.hole_diameter ?? 0 }))
}

// Each placed component by reference designator: its MPN (null when the board has none) and its pins, in port order.
export function partsFromCircuitJson(elements: any[]): Record<string, { mpn: string | null; pins: string[] }> {
	const parts: Record<string, { mpn: string | null; pins: string[] }> = {}
	const refOf = new Map<string, string>()
	for (const c of elements.filter((e) => e.type === "source_component")) {
		refOf.set(c.source_component_id, c.name)
		parts[c.name] = { mpn: typeof c.manufacturer_part_number === "string" ? c.manufacturer_part_number : null, pins: [] }
	}
	for (const port of elements.filter((e) => e.type === "source_port")) {
		const ref = refOf.get(port.source_component_id)
		if (ref) parts[ref].pins.push(port.name)
	}
	return parts
}
