# Research: concurrent agents for robotics (30 Oct 2026)

Two research agents. Items marked † come from search snippets or prior knowledge rather than opened pages.

## Prior art

- **Crowded areas:**
  - Natural-language operator agents for ROS: [ROSA](https://github.com/nasa-jpl/rosa) (NASA JPL) and
    [ros-mcp-server](https://github.com/robotmcp/ros-mcp-server) †
  - ROS code generators: ROScribe; RoboCopilot-X, which runs planner → executor → critic → validator in sequence †
  - LLM planning for multiple robots: RoCo, SMART-LLM, COHERENT, EMOS, GenSwarm †
  - Fleets from the lablab "AI Meets Robotics" hackathon (Feb 2026): Fleetmind, AgroMind, DroneOS
  - Eureka-style reward design, which also needs a GPU †
- **Partly taken:** LLM-generated scenarios for simulation testing.
  - AutoSimTest (ICSE 2025, drones), [PlannerForge](https://arxiv.org/abs/2609.08965) (Sep 2026), RVSG (PAL
    Robotics, Gazebo) and Laplace Intelligence (commercial, Oct 2026).
  - These are all pipelines or single loops, and they target drones and cars. †
- **Open:**
  - Several agents at once that share a live failure board and write, fuzz and fix robot code while dropping
    duplicate work.
  - Attacker and defender agents co-evolving concurrently.
- **JigJoy:** none of the 40 gallery entries touch robotics or physical simulation, and none of JigJoy's repos do.

## Ranked angles (originality × demo × feasibility on a CPU-only laptop)

1. **A robot CI swarm.**
   - Builders write a controller split into sensing, control and recovery modules.
   - Fuzzers generate disturbances, slopes and payloads.
   - A triager clusters the failures on a shared board, and fixers lease a cluster so no bug is fixed twice.
   - Demo: a grid of parallel simulations turning from red to green.
2. **Red team vs blue team co-evolution.**
   - Attackers edit the world (terrain, pushes, sensor noise) while defenders patch the controller, concurrently.
   - An archive stops anyone resubmitting a known attack.
   - This was the most original angle found.
3. **A parallel tuning lab with shared findings.** Each agent owns one region of the parameter space. Easiest,
   medium novelty.
4. **A studio that evolves robot bodies (MJCF).** Riskier, because LLM-written MJCF often doesn't simulate cleanly.
5. **A fleet with one agent per robot.** Crowded.

## Toolchain (CPU-only, headless)

| Layer | Pick | Notes |
|---|---|---|
| Physics | **MuJoCo 3.17** (`uv pip install mujoco`), from Python or the `@mujoco/mujoco` WASM npm package (3.17.0) | Needs no GPU. Hundreds of simple simulations run in parallel. `mujoco.batch` / `mujoco.rollout` step many simulations on a thread pool |
| Models | Hand-written MJCF (a diff-drive is about 40 lines) or [mujoco_menagerie](https://github.com/google-deepmind/mujoco_menagerie) | Check the model with `MjModel.from_xml_path` before scoring it |
| Live visuals | rerun.io web viewer or Foxglove | The browser renders, so no GPU is needed |
| Video | MuJoCo `Renderer`, `MUJOCO_GL=osmesa` | Slow on CPU, so render only the best and worst runs |
| ROS 2 (stretch) | Jazzy (LTS) or Lyrical (May 2026) via `osrf/ros:*-simulation` Docker; Gazebo server mode; rosbridge + roslib for TypeScript | About 4–6 Nav2+Gazebo stacks at once on this laptop. DDS crosstalk unless each gets its own `ROS_DOMAIN_ID`. Cameras without a GPU are unverified |
| GPU options (in the pitch, not this laptop) | Isaac Sim/Lab, MJX/Brax, Genesis | Massive parallel rollouts on NVIDIA. Mention them as the path to scale |

**Top risks:**
- ROS/Gazebo can eat a day, so keep it as a stretch goal with a 30-minute go/no-go test.
- Rendering on a CPU-only machine is slow.
- LLM-written controllers can diverge, so use subprocess timeouts and keep a known-good baseline.

**Smoke test (30 Oct, `../spikes/robotics/smoke.py`):** MuJoCo 3.17.0 in `.venv` ran 200 randomized cart-pole
simulations of 10 s each in 7.6 s. That's single-threaded, with the controller loop in Python, which works out to about
**263× real time**. The PD controller balanced 200 of 200. `mujoco.batch` isn't a top-level attribute, so check the
import path before relying on it.
