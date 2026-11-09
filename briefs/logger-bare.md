# Brief: climate logger, bare board for the lab

## What we want
A small battery-powered logger that records temperature and humidity and lets a phone read the history over
Bluetooth Low Energy. Our lab uses it on the bench and in the climate chamber, as a **bare board with no case**: we
handle the boards ourselves, and a case would only trap heat around the sensor.

## Must have
- **Temperature and humidity sensing.** Room-grade accuracy is enough: about ±0.2 °C and ±2 %RH.
- **Bluetooth Low Energy.** A phone app reads the latest value and downloads the stored history.
- **Runs on one Li-ion cell for at least 6 months** with a reading every few minutes. Assume a small single-cell pouch,
  around 500 mAh.
- **USB-C** for charging and for flashing firmware. Nobody should need a special cable.
- **A status LED** that blinks briefly on each reading and shows charging state.
- **One button** on the board that wakes it so a phone can connect at once.
- **Small.** The board should be about 50 × 30 mm.

## Nice to have
- Parts that JLCPCB can assemble from stock, so a first batch of 10 is cheap.

## Out of scope
- A display, any other button, Wi-Fi, or a cloud backend.
- Waterproofing. It lives indoors.
- Any case or enclosure.

## How we'll judge the first prototype
It charges over USB-C, it shows up on a phone over BLE, and the readings look sane next to a reference thermometer.
