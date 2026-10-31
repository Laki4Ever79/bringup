# Brief: pocket BLE beacon

## What we want
A small battery-powered Bluetooth Low Energy beacon that a phone can find. People clip it to a bag, stick it on a shelf
or leave it in a room, and a phone app sees it nearby. Pressing its button makes it show up on the phone right away.

## Must have
- **Bluetooth Low Energy.** It advertises about once a minute, so a phone can find it, and it accepts a connection.
- **Runs on one Li-ion cell for at least 3 months.** Assume a small single-cell pouch, around 500 mAh.
- **USB-C** for charging and for flashing firmware. Nobody should need a special cable.
- **A status LED** that blinks briefly each time it wakes and shows charging state.
- **One button**, reachable through the case, that wakes it to advertise at once.
- **Small.** The board should be about 50 × 30 mm, so the whole thing fits in a pocket-sized case.

## Nice to have
- A case that prints on a hobby FDM printer with no supports, with openings that line up with the USB-C port and the
  button.
- Parts that JLCPCB can assemble from stock, so a first batch of 10 is cheap.

## Out of scope
- Sensors of any kind, for now. (A temperature/humidity sensor may come later.)
- A display, Wi-Fi, or a cloud backend.
- Waterproofing.

## How we'll judge the first prototype
It charges over USB-C, a phone finds it over BLE within a minute and at once after a button press, and the board drops
into the case without filing anything.
