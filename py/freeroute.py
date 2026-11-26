"""Freerouting's way in and out of a KiCad board (src/tools/freerouting.ts), run in the kicad/kicad image.

  freeroute.py dsn <board.kicad_pcb> <out.dsn> <track_mm> <clearance_mm> <via_mm> <drill_mm> <edge_mm>
      sets the default net class to the fab's track, clearance and via, rings the board's edge with track/via keep-outs
      <edge_mm> wide (Freerouting honours keep-outs, not KiCad's copper-to-edge rule), and writes Specctra DSN.
  freeroute.py ses <board.kicad_pcb> <in.ses> <out.kicad_pcb> [<widths.json> <clearance_mm> <edge_mm>]
      imports Freerouting's session (its tracks and vias), drops the edge keep-outs again, widens each net in widths.json
      ({net: mm}) where clearance allows (widen), refills the copper pours around the new tracks and vias, and saves the
      routed board.
  freeroute.py widen <board.kicad_pcb> <out.kicad_pcb> <widths.json> <clearance_mm> <edge_mm>
      the widening alone (for a board routed elsewhere and for the test).
  freeroute.py refill <board.kicad_pcb> <out.kicad_pcb>
      refills the copper pours only (the same step, for a board routed elsewhere and for the test).
"""
import json
import sys
import pcbnew

KEEPOUT = "bringup-edge-keepout"


def edge_ring(board, mm):
    box = board.GetBoardEdgesBoundingBox()
    x0, y0, x1, y1 = box.GetLeft(), box.GetTop(), box.GetRight(), box.GetBottom()
    w = pcbnew.FromMM(mm)
    for (ax, ay, bx, by) in ((x0, y0, x1, y0 + w), (x0, y1 - w, x1, y1), (x0, y0, x0 + w, y1), (x1 - w, y0, x1, y1)):
        z = pcbnew.ZONE(board)
        z.SetIsRuleArea(True)
        z.SetDoNotAllowTracks(True)
        z.SetDoNotAllowVias(True)
        z.SetDoNotAllowPads(False)
        z.SetDoNotAllowZoneFills(True) if hasattr(z, "SetDoNotAllowZoneFills") else None
        z.SetZoneName(KEEPOUT)
        ls = pcbnew.LSET()
        ls.AddLayer(pcbnew.F_Cu)
        ls.AddLayer(pcbnew.B_Cu)
        z.SetLayerSet(ls)
        o = z.Outline()
        o.NewOutline()
        for (px, py) in ((ax, ay), (bx, ay), (bx, by), (ax, by)):
            o.Append(px, py)
        board.Add(z)


def dsn(pcb, out, track, clearance, via, drill, edge):
    b = pcbnew.LoadBoard(pcb)
    nc = b.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(pcbnew.FromMM(track))
    nc.SetClearance(pcbnew.FromMM(clearance))
    nc.SetViaDiameter(pcbnew.FromMM(via))
    nc.SetViaDrill(pcbnew.FromMM(drill))
    edge_ring(b, edge)
    # The copper pours stay out of the DSN (only this in-memory board loses them; the file keeps them for the ses step):
    # handed to Freerouting as planes it took every pad on one as joined through it, but the refilled pour came back cut
    # by the tracks on its layer, and the pads on its pieces unjoined (the arm board, 26 Nov 2026: 6 GND items
    # unconnected). Without them it routes every connection as a track; the pour, refilled after, is copper on top.
    for z in [z for z in b.Zones() if not z.GetIsRuleArea()]:
        b.Remove(z)
    if not pcbnew.ExportSpecctraDSN(b, out):
        sys.exit("DSN export failed")


def ses(pcb, ses_path, out, widths_path=None, clearance=0.15, edge=0.35):
    b = pcbnew.LoadBoard(pcb)
    if not pcbnew.ImportSpecctraSES(b, ses_path):
        sys.exit("SES import failed")
    for z in [z for z in b.Zones() if z.GetZoneName() == KEEPOUT]:
        b.Remove(z)
    if widths_path:
        with open(widths_path) as f:
            widen(b, json.load(f), clearance, edge)
    # The pours' fill is what tscircuit drew before any track existed: Freerouting routes over the planes, so without a
    # refill every new track and via of another net sits on the old fill (the arm board, 25 Nov 2026: 499 "zone
    # clearance 0.15 mm, actual 0" and 199 isolated copper).
    refill(b)
    pcbnew.SaveBoard(out, b)


# A rail routed at the fab's default track, widened afterwards the way a person routes power by hand (lead-2, 26 Nov 2026:
# option c): each segment of a wide net takes the widest width up to its need that keeps <clearance> from every other
# net's track, via and pad on its layer and <edge> from the board's edge, in 0.05 mm steps; where nothing wider fits (into
# a fine-pitch pin) it stays as routed. Freerouting's own neck-down didn't reach 0.5 mm-pitch pads: with the rails'
# widths as net classes it left 20 connections of the arm board unrouted. The pours are refilled afterwards (refill).
STEP_MM = 0.05
HOLE_CLEARANCE_MM = 0.2


def widen(b, widths, clearance, edge):
    clr = pcbnew.FromMM(clearance)
    box = b.GetBoardEdgesBoundingBox()
    inner = (box.GetLeft() + pcbnew.FromMM(edge), box.GetTop() + pcbnew.FromMM(edge), box.GetRight() - pcbnew.FromMM(edge), box.GetBottom() - pcbnew.FromMM(edge))
    copper = [t for t in b.GetTracks()] + [p for fp in b.GetFootprints() for p in fp.Pads()]
    # Every drilled hole (an unplated locating hole has no copper on any layer, so the copper check never sees it) keeps
    # the fab's hole clearance (FAB_RULES.minHoleClearanceMm, 0.2 mm): the arm board at 71×54, 26 Nov 2026, had VSERVO1
    # widened to 0.15 mm from JD1's locating holes.
    holes = [p for fp in b.GetFootprints() for p in fp.Pads() if p.HasHole()] + [t for t in b.GetTracks() if t.Type() == pcbnew.PCB_VIA_T]
    hole_clr = pcbnew.FromMM(HOLE_CLEARANCE_MM)
    for net, mm in widths.items():
        segs = [t for t in b.GetTracks() if t.GetNetname() == net and t.Type() == pcbnew.PCB_TRACE_T]
        for t in segs:
            layer = t.GetLayer()
            others = [o for o in copper if o.GetNetname() != net and o.IsOnLayer(layer)]
            have, want = t.GetWidth(), pcbnew.FromMM(mm)
            w = want
            while w > have:
                t.SetWidth(w)
                if fits(t, layer, others, clr, inner) and clear_of_holes(t, layer, net, holes, hole_clr):
                    break
                w -= pcbnew.FromMM(STEP_MM)
            if w <= have:
                t.SetWidth(have)


def fits(t, layer, others, clr, inner):
    bb = t.GetBoundingBox()
    if bb.GetLeft() < inner[0] or bb.GetTop() < inner[1] or bb.GetRight() > inner[2] or bb.GetBottom() > inner[3]:
        return False
    bb.Inflate(clr)
    shape = t.GetEffectiveShape(layer)
    for o in others:
        if o is t or not bb.Intersects(o.GetBoundingBox()):
            continue
        if shape.Collide(o.GetEffectiveShape(layer), clr - 1):
            return False
    return True


def clear_of_holes(t, layer, net, holes, clr):
    bb = t.GetBoundingBox()
    bb.Inflate(clr)
    shape = t.GetEffectiveShape(layer)
    for h in holes:
        if h.GetNetname() == net and h.GetNetname() != "":
            continue
        if not bb.Intersects(h.GetBoundingBox()):
            continue
        if shape.Collide(h.GetEffectiveHoleShape(), clr - 1):
            return False
    return True


def refill(b):
    zones = [z for z in b.Zones() if not z.GetIsRuleArea()]
    # A piece of pour that reaches no pad of its net is floating copper (KiCad's isolated_copper): removed.
    for z in zones:
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    if zones:
        pcbnew.ZONE_FILLER(b).Fill(zones)


if __name__ == "__main__":
    if sys.argv[1] == "dsn":
        dsn(sys.argv[2], sys.argv[3], *map(float, sys.argv[4:9]))
    elif sys.argv[1] == "refill":
        b = pcbnew.LoadBoard(sys.argv[2])
        refill(b)
        pcbnew.SaveBoard(sys.argv[3], b)
    elif sys.argv[1] == "ses":
        ses(sys.argv[2], sys.argv[3], sys.argv[4], *sys.argv[5:6], *map(float, sys.argv[6:8]))
    elif sys.argv[1] == "widen":
        b = pcbnew.LoadBoard(sys.argv[2])
        with open(sys.argv[4]) as f:
            widen(b, json.load(f), float(sys.argv[5]), float(sys.argv[6]))
        refill(b)
        pcbnew.SaveBoard(sys.argv[3], b)
    else:
        sys.exit(__doc__)
