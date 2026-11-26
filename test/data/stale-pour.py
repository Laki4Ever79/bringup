"""Makes a board with a stale pour, as a Freerouting import left one before 26 Nov 2026: a GND pour on the bottom filled
first, then a track of another net drawn across it with no refill.  stale-pour.py <in.kicad_pcb> <out.kicad_pcb>"""
import sys
import pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
box = b.GetBoardEdgesBoundingBox()
m = pcbnew.FromMM(1)
gnd = b.FindNet("GND")
z = pcbnew.ZONE(b)
z.SetLayer(pcbnew.B_Cu)
z.SetNet(gnd)
z.SetLocalClearance(pcbnew.FromMM(0.3))
o = z.Outline()
o.NewOutline()
for (x, y) in ((box.GetLeft() + m, box.GetTop() + m), (box.GetRight() - m, box.GetTop() + m), (box.GetRight() - m, box.GetBottom() - m), (box.GetLeft() + m, box.GetBottom() - m)):
    o.Append(x, y)
b.Add(z)
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
other = [n for n in b.GetNetsByName().values() if n.GetNetname() not in ("", "GND")][0]
t = pcbnew.PCB_TRACK(b)
cy = (box.GetTop() + box.GetBottom()) // 2
t.SetStart(pcbnew.VECTOR2I(box.GetLeft() + 3 * m, cy))
t.SetEnd(pcbnew.VECTOR2I(box.GetRight() - 3 * m, cy))
t.SetWidth(pcbnew.FromMM(0.2))
t.SetLayer(pcbnew.B_Cu)
t.SetNet(other)
b.Add(t)
pcbnew.SaveBoard(sys.argv[2], b)
