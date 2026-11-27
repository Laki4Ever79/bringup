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
import math
import os
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


def inner_keepout(board):
    box = board.GetBoardEdgesBoundingBox()
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    z.SetDoNotAllowTracks(True)
    z.SetDoNotAllowVias(False)
    z.SetDoNotAllowPads(False)
    z.SetZoneName(KEEPOUT)
    ls = pcbnew.LSET()
    ls.AddLayer(pcbnew.In1_Cu)
    ls.AddLayer(pcbnew.In2_Cu)
    z.SetLayerSet(ls)
    o = z.Outline()
    o.NewOutline()
    for (px, py) in ((box.GetLeft(), box.GetTop()), (box.GetRight(), box.GetTop()), (box.GetRight(), box.GetBottom()), (box.GetLeft(), box.GetBottom())):
        o.Append(px, py)
    board.Add(z)


def dsn(pcb, out, track, clearance, via, drill, edge):
    b = pcbnew.LoadBoard(pcb)
    four = b.GetCopperLayerCount() >= 4
    nc = b.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(pcbnew.FromMM(track))
    nc.SetClearance(pcbnew.FromMM(clearance))
    nc.SetViaDiameter(pcbnew.FromMM(via))
    nc.SetViaDrill(pcbnew.FromMM(drill))
    edge_ring(b, edge)
    # Before any zone is removed: after that, GetFootprints() hands back raw SWIG objects (the arm, 27 Nov 2026:
    # "'SwigPyObject' object has no attribute 'Pads'").
    # Ground isn't Freerouting's job on 4 layers: In1 is its plane and stitch joins every ground pad to it by a via.
    # Routed as tracks, ground was the most connections and the densest net: lead-3's 100x80 CNC (mock 13: GND 67
    # unrouted; mock 15 rev 9: "over 50 traces remaining"). In the DSN copy only, its pads are netless obstacles:
    # Freerouting keeps clear of them and routes the other nets; the board file keeps their net. Only ground: taking
    # every plane net off (with an inner keepout) left 24 unrouted on the arm board, 26 Nov 2026.
    # The ground-plane pass (BRINGUP_GND_PLANE=1), run when the first pass, ground routed, left connections unrouted
    # (src/tools/freerouting.ts): ground routed as tracks joins the small pads stitch finds no room beside (the arm: 3).
    if four and os.environ.get("BRINGUP_GND_PLANE") == "1":
        for fp in b.GetFootprints():
            for pad in fp.Pads():
                if pad.GetNetname() == "GND":
                    pad.SetNetCode(0)
    # The outer layers' copper pours stay out of the DSN (only this in-memory board loses them; the file keeps them):
    # handed to Freerouting as planes it took every pad on one as joined through it, but the refilled pour came back cut
    # by the tracks on its layer, and the pads on its pieces unjoined (the arm board, 26 Nov 2026: 6 GND items
    # unconnected). Without them it routes every connection as a track; the pour, refilled after, is copper on top.
    for z in [z for z in b.Zones() if not z.GetIsRuleArea() and (z.IsOnLayer(pcbnew.F_Cu) or z.IsOnLayer(pcbnew.B_Cu))]:
        b.Remove(z)
    # A 4-layer board's inner layers are planes (ground on In1, the wide rails' regions on In2). Freerouting can't take
    # them: it treats a plane as solid copper, so a via of another net can't cross it (the arm board, 26 Nov 2026: 35
    # connections unrouted; its plane_as_obstacle and conduction_is_obstacle settings changed nothing). So it routes the
    # board as on 2 layers, every net on the outer layers (leaving the plane nets out made it worse: 24 unrouted, fanout
    # failing on 88 pins), and the ses step adds the planes' copper: each plane-net pad joined to its plane by a via
    # beside it (stitch), so the rail's current has the plane as well as its track.
    if four:
        # The inner layers route signals too (more room: lead-3's CNC didn't route on 2); the planes are refilled around
        # what lands there and stitched after (stitch checks every copper layer). A track keepout on them blocked
        # Freerouting's vias as well (the arm, 26 Nov 2026: 45 connections unrouted where 2 layers routed them all).
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
    if b.GetCopperLayerCount() >= 4:
        stitch(b, plane_nets(b), clearance, edge)
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


# The nets an inner layer's pour carries (a 4-layer board's ground and power planes).
def plane_nets(b):
    inner = (pcbnew.In1_Cu, pcbnew.In2_Cu)
    return {z.GetNetname() for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() and any(z.IsOnLayer(l) for l in inner)}


# Each surface pad of a plane's net joined to its plane: a through via beside it (the fab's via, 0.45 / 0.25 mm) and a
# short track from the pad, at the first spot on rings around the pad that keeps the clearance from every other net's
# copper on every layer it touches, the hole clearance from every drilled hole, and the edge. A through-hole pad already
# reaches the planes. A pad with no free spot stays unjoined, and the DRC says so.
STITCH_VIA_MM = (0.45, 0.25)
STITCH_TRACK_MM = 0.3


def stitch(b, nets, clearance, edge):
    clr = pcbnew.FromMM(clearance)
    hole_clr = pcbnew.FromMM(HOLE_CLEARANCE_MM)
    box = b.GetBoardEdgesBoundingBox()
    e = pcbnew.FromMM(edge)
    inner = (box.GetLeft() + e, box.GetTop() + e, box.GetRight() - e, box.GetBottom() - e)
    copper_layers = list(b.GetEnabledLayers().CuStack())
    inner_layers = (pcbnew.In1_Cu, pcbnew.In2_Cu)
    regions = {}
    for z in b.Zones():
        if not z.GetIsRuleArea() and any(z.IsOnLayer(l) for l in inner_layers):
            regions.setdefault(z.GetNetname(), []).append(z.Outline())
    margin = pcbnew.FromMM(STITCH_VIA_MM[0] / 2 + clearance)

    # A via joins its plane only inside its own net's region of the inner layer, clear of the region's edge (a rail's
    # region of In2 is not the whole layer; the arm, 26 Nov 2026: stitch vias outside it were left dangling).
    def in_region(net, pos):
        for poly in regions.get(net, []):
            if all(poly.Contains(pcbnew.VECTOR2I(pos.x + dx, pos.y + dy)) for dx, dy in ((0, 0), (margin, 0), (-margin, 0), (0, margin), (0, -margin))):
                return True
        return False
    def via_at(pad, pos):
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(pos)
        via.SetWidth(pcbnew.FromMM(STITCH_VIA_MM[0]))
        via.SetDrill(pcbnew.FromMM(STITCH_VIA_MM[1]))
        via.SetNet(pad.GetNet())
        return via

    def free(item, net, layers):
        copper = [x for x in b.GetTracks()] + [q for f in b.GetFootprints() for q in f.Pads()]
        return all(fits(item, l, [o for o in copper if o.GetNetname() != net and o.IsOnLayer(l)], clr, inner) for l in layers)

    def holes_ok(pos, net):
        holes = [q for f in b.GetFootprints() for q in f.Pads() if q.HasHole()] + [x for x in b.GetTracks() if x.Type() == pcbnew.PCB_VIA_T]
        v = via_at_net(net, pos)
        return clear_of_holes(v, pcbnew.F_Cu, net, holes, hole_clr) and all(drill_gap(pos, STITCH_VIA_MM[1], h) >= HOLE_TO_HOLE_MM for h in holes)

    def via_at_net(net, pos):
        v = pcbnew.PCB_VIA(b)
        v.SetPosition(pos)
        v.SetWidth(pcbnew.FromMM(STITCH_VIA_MM[0]))
        v.SetDrill(pcbnew.FromMM(STITCH_VIA_MM[1]))
        v.SetNet(b.FindNet(net))
        return v

    joined = set()
    unjoined = []
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetname() not in nets or pad.HasHole():
                continue
            layer = pcbnew.F_Cu if pad.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
            c = pad.GetPosition()
            net = pad.GetNetname()
            # A pad that holds a via (a QFN's exposed pad, a regulator's tab) takes one at its centre, a thermal via too:
            # beside a fine-pitch package the rings found no room (the CNC's four TMC2209s, 27 Nov 2026: 26 GND pads
            # unjoined once ground left the router).
            if min(pad.GetSize().x, pad.GetSize().y) >= pcbnew.FromMM(STITCH_VIA_MM[0] + 0.1) and in_region(net, c):
                v = via_at(pad, c)
                if free(v, net, [l for l in copper_layers if l != layer]) and holes_ok(c, net):
                    b.Add(v)
                    joined.add(pad.m_Uuid.AsString())
                    continue
            reach = max(pad.GetSize().x, pad.GetSize().y) / 2
            placed = False
            for extra in (0.55, 0.9, 1.3, 1.8):
                r = reach + pcbnew.FromMM(extra)
                for k in range(16):
                    a = 2 * math.pi * k / 16
                    pos = pcbnew.VECTOR2I(int(c.x + r * math.cos(a)), int(c.y + r * math.sin(a)))
                    if not (inner[0] < pos.x < inner[2] and inner[1] < pos.y < inner[3]):
                        continue
                    via = pcbnew.PCB_VIA(b)
                    via.SetPosition(pos)
                    via.SetWidth(pcbnew.FromMM(STITCH_VIA_MM[0]))
                    via.SetDrill(pcbnew.FromMM(STITCH_VIA_MM[1]))
                    via.SetNet(pad.GetNet())
                    t = pcbnew.PCB_TRACK(b)
                    t.SetStart(c)
                    t.SetEnd(pos)
                    t.SetWidth(pcbnew.FromMM(STITCH_TRACK_MM))
                    t.SetLayer(layer)
                    t.SetNet(pad.GetNet())
                    net = pad.GetNetname()
                    copper = [x for x in b.GetTracks()] + [q for f in b.GetFootprints() for q in f.Pads()]
                    if not in_region(net, pos):
                        continue
                    ok = all(fits(via, l, [o for o in copper if o.GetNetname() != net and o.IsOnLayer(l)], clr, inner) for l in copper_layers)
                    ok = ok and fits(t, layer, [o for o in copper if o.GetNetname() != net and o.IsOnLayer(layer)], clr, inner)
                    holes = [q for f in b.GetFootprints() for q in f.Pads() if q.HasHole()] + [x for x in b.GetTracks() if x.Type() == pcbnew.PCB_VIA_T]
                    ok = ok and clear_of_holes(via, pcbnew.F_Cu, net, holes, hole_clr)
                    # Drill to drill, whatever the net (FAB_RULES.minHoleToHoleMm): a stitch via landed on a GND via
                    # Freerouting had put there (the arm, 26 Nov 2026: 6 hole_to_hole at 0 mm).
                    ok = ok and all(drill_gap(pos, STITCH_VIA_MM[1], h) >= HOLE_TO_HOLE_MM for h in holes)
                    if ok:
                        b.Add(via)
                        b.Add(t)
                        placed = True
                        break
                if placed:
                    break
            if placed:
                joined.add(pad.m_Uuid.AsString())
            else:
                unjoined.append(pad)
    # A pad with no room for a via (a fine-pitch ground pin) joins the nearest pad of its net on the same part that is
    # joined, by a straight track on its layer where that fits (a TMC2209's GND pin 3 to its exposed pad).
    for pad in unjoined:
        layer = pcbnew.F_Cu if pad.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
        net = pad.GetNetname()
        # Its own part's joined pads first, then any joined pad or via of its net within JOIN_MM (a capacitor's ground
        # pad beside another part's stitch via: the CNC's C6, 27 Nov 2026).
        here = pad.GetPosition()
        dist = lambda q: (q.GetPosition() - here).EuclideanNorm()
        own = [q for q in pad.GetParentFootprint().Pads() if q.GetNetname() == net and q.m_Uuid.AsString() in joined and q.IsOnLayer(layer)]
        near = [q for f in b.GetFootprints() for q in f.Pads() if q.GetNetname() == net and q.m_Uuid.AsString() in joined and q.IsOnLayer(layer) and q.GetParentFootprint() is not pad.GetParentFootprint()]
        near += [v for v in b.GetTracks() if v.Type() == pcbnew.PCB_VIA_T and v.GetNetname() == net]
        mates = sorted(own, key=dist)[:3] + sorted((q for q in near if dist(q) <= pcbnew.FromMM(JOIN_MM)), key=dist)[:4]
        for q in mates:
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(here)
            t.SetEnd(q.GetPosition())
            t.SetWidth(pcbnew.FromMM(STITCH_TRACK_MM))
            t.SetLayer(layer)
            t.SetNet(pad.GetNet())
            if free(t, net, [layer]):
                b.Add(t)
                joined.add(pad.m_Uuid.AsString())
                break


HOLE_TO_HOLE_MM = 0.25
JOIN_MM = 3.0


def drill_gap(pos, drill_mm, h):
    c = h.GetPosition()
    d = h.GetDrillValue() if h.Type() == pcbnew.PCB_VIA_T else max(h.GetDrillSize().x, h.GetDrillSize().y)
    return pcbnew.ToMM(int(math.hypot(c.x - pos.x, c.y - pos.y))) - drill_mm / 2 - pcbnew.ToMM(d) / 2


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
    elif sys.argv[1] == "stitch":
        b = pcbnew.LoadBoard(sys.argv[2])
        nets = plane_nets(b)
        stitch(b, nets, float(sys.argv[4]), float(sys.argv[5]))
        refill(b)
        pcbnew.SaveBoard(sys.argv[3], b)
        pads = [q for f in b.GetFootprints() for q in f.Pads() if q.GetNetname() in nets and not q.HasHole()]
        vias = [x for x in b.GetTracks() if x.Type() == pcbnew.PCB_VIA_T and x.GetNetname() in nets]
        print("plane nets", sorted(nets), "surface pads", len(pads), "stitch vias", len(vias))
    elif sys.argv[1] == "widen":
        b = pcbnew.LoadBoard(sys.argv[2])
        with open(sys.argv[4]) as f:
            widen(b, json.load(f), float(sys.argv[5]), float(sys.argv[6]))
        refill(b)
        pcbnew.SaveBoard(sys.argv[3], b)
    else:
        sys.exit(__doc__)
