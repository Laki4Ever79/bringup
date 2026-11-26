# Brief: desktop CNC engraver

## What we want
A small 3-axis CNC machine for a desk: it engraves and cuts soft materials (wood, plywood, acrylic, PCB blanks) from
G-code, homes itself on its limit switches, and is built from parts a hobbyist can buy or print. It plugs into the mains
through one power brick and takes its jobs over USB-C or Wi-Fi.

## Must have
- **Work area of about 300 × 200 × 50 mm** (X × Y × Z travel), on a frame that fits a desk, about **450 × 350 mm**.
- **Three stepper-driven axes**: NEMA 17 motors on T8 lead screws and linear rails, quiet drivers whose current is set in
  software, **positioning repeatable to 0.05 mm**, rapids of at least **1500 mm/min**.
- **Cuts 3 mm plywood in one pass** at **600 mm/min** with a 3.175 mm end mill.
- **A spindle of up to 100 W** on 24 V, switched and speed-controlled by the controller, **off whenever the machine is
  not running a job** and when the emergency stop is pressed.
- **Homes on limit switches** on every axis, and stops at once if a switch trips during a job.
- **An emergency stop button** on the front that cuts the motors and the spindle in hardware.
- **One 24 V mains brick**, sized with headroom for every motor and the spindle at once.
- **Runs standard G-code** with open firmware (FluidNC or grblHAL) that the board's pin map configures, and **one USB-C
  cable** to program it and send jobs.

## Nice to have
- Jobs over Wi-Fi from a phone or laptop browser.
- A probe input for setting the tool's height.
- A 3D-printed electronics box with a fan over the drivers.
