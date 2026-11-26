# Brief: desktop robot arm

## What we want
A desktop robot arm that a maker can print, screw together and run on a desk: it picks a small cube off the table and
drops it into a cup, over and over, from a scripted pick-and-place program. It stands on its own base plate, runs from
a laptop power brick, and is programmed and watched over one USB-C cable.

## Must have
- **Reach about 280 mm** from the shoulder axis to the fingertips, with the arm stretched out.
- **Holds a 100 g design payload** at full reach (the servos keep a margin under their stall torque there).
- **Picks a 50 g cube** (about 30 mm on a side) off the table and **drops it into a cup 250 mm from the pick point**
  (the cup about 40 mm tall), **5 times in a row** without a miss.
- **5 joints plus a gripper**: base yaw, shoulder, elbow, wrist pitch, wrist roll, and the gripper.
- **Hobby PWM servos**: an MG996R at the base, the shoulder and the elbow; an SG90 at the wrist pitch, the wrist roll
  and the gripper. They run from a **6 V** servo rail.
- **A fixed base plate** that doesn't tip with the payload at full reach in any direction: heavy enough on its own (or
  with ballast), or clamped to the desk.
- **Powered by a 20 V mains brick of 120 W** (a Mean Well GST120A20 desktop unit with the 5.5 × 2.5 mm plug), for
  margin when several servos stall at once.
- **One USB-C cable to program and talk to the board**, as on our other robots.

## Nice to have
- A status LED that shows ready, moving and fault.

## Out of scope
- Vision: the pick and drop points are fixed.
- Learning-based control (teleoperation, imitation learning).
- Bus servos (a later version of the same arm).
- Mounting the arm on a mobile robot.
