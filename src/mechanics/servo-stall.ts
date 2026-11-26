// The rover servo plugs' stall figure (moved out of checks.ts so leaf modules can read it without importing the checks).
// A standard hobby servo's stall current on the board's 5 V servo supply: TowerPro's MG996R datasheet gives 2.5 A
// stalled at 6 V; a stalled motor draws its supply over its winding resistance, so at 5 V that is 2.5 x 5 / 6 = 2.08 A
// (micro servos far less). Before (25 Nov 2026) the 6 V figure stood for 5 V: 2.5 A with the 1.25x headroom asked 3.1 A
// of the 3 A servo header, a FAILS figure on run 21's J3/J4 that no agent could act on (the servo's plug is set by its
// 2.54 mm lead). The 5 V step-down's efficiency from a 2S pack is an ESTIMATE (Pololu D36V50F5's curves run 80-90 %).
export const SERVO_STALL_AT_6V_A = 2.5
export const SERVO_STALL_A = +((SERVO_STALL_AT_6V_A * 5) / 6).toFixed(2)
export const SERVO_STALL_SOURCE = { url: "https://courses.ece.cornell.edu/ece5990/ECE5725_Spring2020_Projects/May_15_Demo/Smart%20Lock/W_pp445_yl656/datasheet/MG996R_Tower-Pro.pdf", where: "TowerPro MG996R datasheet: stall current 2.5 A at 6 V; scaled to the 5 V servo supply (a stalled motor's current is its voltage over its winding resistance): 2.08 A" }
export const SERVO_SUPPLY_EFF = 0.85
