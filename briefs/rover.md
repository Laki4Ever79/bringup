# Brief: indoor rover

## What we want
A small wheeled rover that drives around a home or office on its own, turns away before it touches a wall, and carries
a temperature and humidity sensor so it can map a room's climate as it goes. It runs on one rechargeable cell and is
charged from a phone charger over USB-C.

## Must have
- **Drives indoors at about 0.3 m/s** on wood, tile and low carpet, and rolls over floor seams and rug edges up to
  **3 mm** (door thresholds are out of scope).
- **Avoids walls**: it sees a wall ahead and stops at least **15 cm** short of it, then turns away.
- **Runs at least 30 minutes** per charge on one Li-ion cell, **charged over USB-C**.
- **Carries the temperature and humidity sensor** (about 20 g with its mount) and reports readings over Bluetooth LE.
- **Small and light**: fits a shoebox, about **15 × 12 cm**, under 500 g with everything on it.

## Nice to have
- A status LED that shows it is driving or charging.
