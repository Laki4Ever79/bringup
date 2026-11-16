"""Freerouting's way in and out of a KiCad board (src/tools/freerouting.ts), run in the kicad/kicad image.

  freeroute.py dsn <board.kicad_pcb> <out.dsn> <track_mm> <clearance_mm> <via_mm> <drill_mm> <edge_mm>
      sets the default net class to the fab's track, clearance and via, rings the board's edge with track/via keep-outs
      <edge_mm> wide (Freerouting honours keep-outs, not KiCad's copper-to-edge rule), and writes Specctra DSN.
  freeroute.py ses <board.kicad_pcb> <in.ses> <out.kicad_pcb>
      imports Freerouting's session (its tracks and vias), drops the edge keep-outs again, and saves the routed board.
"""
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
    if not pcbnew.ExportSpecctraDSN(b, out):
        sys.exit("DSN export failed")


def ses(pcb, ses_path, out):
    b = pcbnew.LoadBoard(pcb)
    if not pcbnew.ImportSpecctraSES(b, ses_path):
        sys.exit("SES import failed")
    for z in [z for z in b.Zones() if z.GetZoneName() == KEEPOUT]:
        b.Remove(z)
    pcbnew.SaveBoard(out, b)


if __name__ == "__main__":
    if sys.argv[1] == "dsn":
        dsn(sys.argv[2], sys.argv[3], *map(float, sys.argv[4:9]))
    elif sys.argv[1] == "ses":
        ses(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(__doc__)
