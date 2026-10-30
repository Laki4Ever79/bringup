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
