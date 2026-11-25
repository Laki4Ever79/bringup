# Bringup's toolchain in one image, for machines without `npm run setup` (an `npx bringup-mcp` install): tscircuit + bun,
# Python 3.12 with build123d and MuJoCo, PlatformIO with the ESP32-C3 and ESP32-S3 toolchains. Same pins as
# src/setup/setup.ts. KiCad stays in its own kicad/kicad:10.0 image. src/tools/toolchain.ts builds it on first use (tag =
# a hash of this file and its inputs) and runs each tool through a shim, as the calling user, with the caller's folders
# mounted at their own paths. Build context: the package root.
FROM ghcr.io/astral-sh/uv:0.10.2 AS uv

FROM node:24-bookworm-slim
# libGL/libEGL/glib: the CAD kernel under build123d (OCP) and MuJoCo load them. git: PlatformIO's git-based packages.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git libgl1 libegl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy PLATFORMIO_CORE_DIR=/opt/platformio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=no PATH=/opt/bringup/tools/node/node_modules/.bin:/opt/bringup/.venv/bin:$PATH
WORKDIR /opt/bringup
# tscircuit + bun from the tested lockfile (pinning tscircuit alone let its dependencies float; setup.ts, 21 Nov 2026).
COPY src/setup/tools-node/package.json src/setup/tools-node/package-lock.json tools/node/
RUN npm ci --prefix tools/node && npm cache clean --force
RUN uv venv --python 3.12 .venv \
    && uv pip install --no-cache --python .venv/bin/python platformio==6.2.0 build123d==0.13.0 mujoco==3.17.0
# The C3's and the S3's toolchains (the templates' pinned espressif32 platform). World-writable: the tools run as the
# calling user, and PlatformIO takes lock files in its core dir. In the same layer, so the chmod copies nothing.
COPY templates/fw/platformio.ini /tmp/fw/platformio.ini
COPY templates/fw-rover/platformio.ini /tmp/fw-rover/platformio.ini
# Trimmed of what these builds never use (1.9 GB of 7.3, 25 Nov 2026; both chips' firmware still compiles in the image):
# picolibc (the Arduino core links newlib), and the riscv32 library variants other than the C3's rv32imc.
RUN pio pkg install -d /tmp/fw -e esp32c3 && pio pkg install -d /tmp/fw-rover -e esp32s3 \
    && cd /opt/platformio/packages \
    && rm -rf toolchain-riscv32-esp/picolibc toolchain-xtensa-esp-elf/picolibc \
    && (cd toolchain-riscv32-esp/riscv32-esp-elf/lib && rm -rf rv32i_zicsr_zifencei rv32imac_zicsr_zifencei rv32imafc_zicsr_zifencei rv32imafc_zicsr_zifencei_zba_zbb_zbc_zbs) \
    && rm -rf /tmp/fw /tmp/fw-rover /opt/platformio/.cache && chmod -R a+rwX /opt/platformio
