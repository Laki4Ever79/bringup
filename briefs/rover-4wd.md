# Brief: four-wheel rover for rough floors

## What we want
A small **four-wheel-drive** rover (skid steer: all four wheels driven, no caster) that drives around a workshop or
garage on its own, over cable covers, rubber mats and rough concrete, turns away before it touches a wall, and carries
a temperature and humidity sensor so it can map the room's climate as it goes. It runs on one rechargeable cell and is
charged from a phone charger over USB-C.

## Must have
- **Four-wheel drive** for a rough floor: it drives at about **0.3 m/s** and rolls over edges up to **8 mm** (cable
  covers, mat edges).
- **Avoids walls**: it sees a wall ahead and stops at least **15 cm** short of it, then turns away.
- **Runs at least 30 minutes** per charge on one Li-ion cell, **charged over USB-C**.
- **Carries the temperature and humidity sensor** (about 20 g with its mount) and reports readings over Bluetooth LE.
- **Compact**: about **20 × 18 cm** with its wheels, under 1 kg with everything on it.

## Nice to have
- A status LED that shows it is driving or charging.
