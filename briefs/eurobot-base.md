# Brief: Eurobot base robot

## What we want
A competition-ready base for a Eurobot team: a two-wheeled robot that knows where it is on the table from its wheel
encoders, drives to points on its own, stops for the opponent robot, and leaves room on top for the team's own
mechanism. A first-year team should be able to fork it, add their game mechanism, and pass homologation.

The rules are the Eurobot General Rules 1.2 (official, 2025/26 season):
https://www.eurobot.org/wp-content/uploads/2025/09/Eurobot_General_Rules_1.2_EN.pdf. Each limit below names its
section.

## Must have
- **Fits the start rule**: the robot's outline seen from above has a perimeter of at most **1200 mm** at the start
  (F.3, for example a 290 × 290 mm square), and at most **1400 mm** with anything deployed during the match.
- **Under 350 mm tall** (F.3). Only the emergency stop button may reach **375 mm**.
- **A red emergency stop button** at least **20 mm** across, on top, that a referee can hit with a fist. Pressing it
  cuts power to the motors at once (F.4.c).
- **Starts from a pull cord**: a cord at least **500 mm** long that comes away from the robot when pulled. No other
  start (no remote, no switch) (F.6). Once the cord is pulled, it runs for **100 seconds**, then stops every motor and
  actuator on its own (H.3).
- **Knows where it is**: encoders on both drive wheels; it drives to a point on the table within **2 cm**
  after a full lap.
- **Stops for the other robot**: it sees a robot ahead and stops at least **15 cm** short of it.
- **The beacon support** for the opponent's beacon: a flat, solid, opaque platform **430 ± 5 mm** above the table,
  within a **20 cm** circle around the robot's centre, covered in Velcro (hook side) (F.6). Its mast doesn't count toward the 350 mm (F.3).
- **Safe power**: at most **48 V** on board (F.4.a). One rechargeable pack with its own protection circuit, in a
  solid case, charged by its own charger (F.4.b).
- **One USB-C cable to program and talk to every board**, as on our other robots.

## Nice to have
- A status LED that shows ready, running, and stopped.
- A mounting grid on the top plate for the team's mechanism, with a spare motor output and two servo outputs.

## Out of scope
- The game mechanism itself (each season's game is different; teams add it).
- The fixed beacons and the remote computing device.
- Lidar. The opponent sensor is a simple distance sensor; teams can upgrade it.
