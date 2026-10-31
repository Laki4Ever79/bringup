"""Renders the voice-over lines (docs/video.md) with Soniox TTS, one WAV per beat, into public/vo/.

Run with the livekit project's venv, which has livekit-plugins-soniox and SONIOX_API_KEY in its .env:
    ../../laik/livekit_project/venv/bin/python tools/voice.py [voice] [beat ...]
Paid: one short request per line. The key is read from the environment, never printed.
"""

import asyncio
import os
import sys
import wave
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from livekit.plugins import elevenlabs, soniox
from livekit.plugins.elevenlabs import VoiceSettings

HERE = Path(__file__).resolve().parent.parent
load_dotenv(os.environ.get("SONIOX_ENV", str(HERE.parent.parent.parent / "laik" / "livekit_project" / ".env")))

RATE = 24000
LINES = {
    "b1": "Move a connector five millimetres, and the board, the case and the firmware all have to change. Hardware bugs live in that gap.",
    "b2": "Bringup. Change one thing, and the whole hardware design follows: board, case, firmware and parts, in parallel, and still consistent.",
    "b3": "One brief in. Each agent is its own Mozaik loop, all running at once against one shared design contract. Out come a routed board, a printable case, and firmware for the real pin map.",
    "b4": "Now, one change. It touches one field of the contract: the outline.",
    "b5": "Mozaik situations are the dependency graph. Only the agents the outline affects wake up, and they rework in parallel. The checks go red, and plain code compares what was actually built, until it agrees.",
    "b6": "Consistent again, without anyone coordinating by hand. And no agent can change a field it doesn't own: Mozaik interception holds that until the owner approves.",
    "b7": "With real models: the sensor goes out of stock. The system catches two mismatches the swap caused, and clears them in seventy-five seconds. The case never woke, because nothing physical changed.",
    "b8": "Does the shared contract matter? We applied six changes twice. With it: zero violations. With every team on its own copy: sixteen mismatches would ship. Like a USB port that no longer meets its hole.",
    "b9": "And it reaches real hardware. One more change, in plain words. The firmware rebuilds, the board is reflashed, and the blink is measured on the board itself.",
    "b10": "Change one thing. The whole design follows. That's Bringup.",
}


# ElevenLabs premade voices, for a more expressive read than Soniox (which has no style controls).
ELEVEN = {"george": "JBFqnCBsd6RMkjVDRZzb", "sarah": "EXAVITQu4vr4xnSzMZYI"}


def make_tts(voice: str, session):
    if voice.lower() in ELEVEN:
        return elevenlabs.TTS(
            voice_id=ELEVEN[voice.lower()],
            model="eleven_multilingual_v2",
            voice_settings=VoiceSettings(stability=0.3, similarity_boost=0.8, style=0.45, use_speaker_boost=True),
            encoding="pcm_24000",
            http_session=session,
        )
    if not os.environ.get("SONIOX_API_KEY"):
        raise SystemExit("SONIOX_API_KEY is not set (set SONIOX_ENV to the .env that has it)")
    return soniox.TTS(model="tts-rt-v2", language="en", voice=voice, sample_rate=RATE, http_session=session)


async def main(voice: str, only: list[str]) -> None:
    out = HERE / "public" / "vo" / voice.lower()
    out.mkdir(parents=True, exist_ok=True)
    async with aiohttp.ClientSession() as session:
        tts = make_tts(voice, session)
        for name, text in LINES.items():
            if only and name not in only:
                continue
            frames = []
            async with tts.synthesize(text) as stream:
                async for ev in stream:
                    frames.append(ev.frame)
            pcm = b"".join(bytes(f.data) for f in frames)
            path = out / f"{name}.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(pcm)
            print(f"{path.relative_to(HERE)}: {len(pcm) / 2 / RATE:.1f} s")
        await tts.aclose()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "Maya", sys.argv[2:]))
