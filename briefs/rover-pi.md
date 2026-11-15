# Brief: indoor rover with a Raspberry Pi

## What we want
A wheeled rover that drives around a home or office on its own, with a Raspberry Pi 5 as its brain. The Pi runs ROS 2
and talks to the robot's own boards over USB; those boards keep the motors and the real-time control. The rover turns
away before it touches a wall, and carries a temperature and humidity sensor so it can map a room's climate as it goes.
A Pi needs more power than one cell gives, so it runs on a two-cell (7.4 V) rechargeable pack that comes off the robot
to charge on a standard two-cell balance charger.

## Must have
- **Drives indoors at about 0.3 m/s** on wood, tile and low carpet, and rolls over floor seams and rug edges up to
  **3 mm** (door thresholds are out of scope).
- **Avoids walls**: it sees a wall ahead and stops at least **15 cm** short of it, then turns away.
- **Runs at least 30 minutes** per charge on the two-cell pack, with the Pi running all the while.
- **Carries the Raspberry Pi 5**, bought, not designed here, with a board on top of it that feeds it 5 V from the pack.
  The Pi stays powered when the motors start.
- **Carries the temperature and humidity sensor** (about 20 g with its mount) and reports readings over Bluetooth LE.
- **Small enough for a home**: about **26 × 14 cm** with its wheels, under 1 kg with everything on it.

## Nice to have
- A status LED that shows it is driving.
