# Brief: pocket climate logger

## What we want
A small battery-powered logger that records temperature and humidity and lets a phone read the history over
Bluetooth Low Energy. People leave it in a wine cellar, a greenhouse or a shipping box and check it from their phone
every few days.

## Must have
- **Temperature and humidity sensing.** Room-grade accuracy is enough: about ±0.2 °C and ±2 %RH.
- **Bluetooth Low Energy.** A phone app reads the latest value and downloads the stored history.
- **Runs on one Li-ion cell for at least 6 months** with a reading every few minutes. Assume a small single-cell pouch,
  around 500 mAh.
- **USB-C** for charging and for flashing firmware. Nobody should need a special cable.
- **A status LED** that blinks briefly on each reading and shows charging state.
- **Small.** The board should be about 50 × 30 mm, so the whole thing fits in a pocket-sized case.

## Nice to have
- A case that prints on a hobby FDM printer with no supports, with an opening that lines up with the USB-C port.
- Parts that JLCPCB can assemble from stock, so a first batch of 10 is cheap.

## Out of scope
- A display, buttons beyond what's needed to flash it, Wi-Fi, or a cloud backend.
- Waterproofing. It lives indoors or in a box.

## How we'll judge the first prototype
It charges over USB-C, it shows up on a phone over BLE, the readings look sane next to a reference thermometer, and the
board drops into the case without filing anything.
