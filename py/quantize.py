"""Converts a keyword-spotting model to a full-integer int8 TFLite model and reports what the device must hold.

    tools/mlvenv/bin/python py/quantize.py --out out/model [--keras trained.keras] [--dataset data/wake] [--classes 12]

Bringup doesn't train models: training belongs to the trainers (Edge Impulse, Keras, PyTorch). This is the step after
training that decides whether the model fits the device: the standard TFLite converter with int8 post-training
quantization, calibrated on representative data, then its real sizes.

- --keras: the trained model. Without it, the MLPerf Tiny keyword-spotting reference (DS-CNN, 49x10 MFCC input,
  12 classes; mlcommons/tiny, benchmark/training/keyword_spotting/keras_model.py), untrained: the sizes are real,
  its answers are not.
- --dataset: a py/collect.py dataset. Its clips calibrate the int8 ranges, and its sensor path hash is written into
  the facts, so the model stays tied to the hardware its data came from. Without one, calibration uses noise and the
  facts say so.

Writes <out>/model.tflite, <out>/model_data.cc (the model as a C array for the firmware) and <out>/model.json:
weightsBytes (the .tflite size, which is what flash holds), input shape and type, the tensor arena TFLite Micro allocates, the
calibration source and the dataset's sensor path hash.
"""

import argparse
import json
import re
import sys
import wave
from pathlib import Path

import numpy as np

# The MLPerf Tiny KWS front end: 16 kHz audio, 30 ms frames every 20 ms, 40 mel bands, 10 MFCCs → 49 × 10 per second.
RATE_HZ, FRAME_MS, STRIDE_MS, MELS, MFCCS, CLIP_S = 16000, 30, 20, 40, 10, 1.0


def reference_model(classes):
    """MLPerf Tiny's DS-CNN keyword spotter (mlcommons/tiny keras_model.py, get_model for 'ds_cnn'). Dropout and L2
    regularization only act in training, so they are left out of this inference-shape copy."""
    import tensorflow as tf
    from tensorflow.keras import layers

    frames = int((CLIP_S * 1000 - FRAME_MS) / STRIDE_MS) + 1
    inp = layers.Input(shape=(frames, MFCCS, 1))
    x = layers.Conv2D(64, (10, 4), strides=(2, 2), padding="same")(inp)
    x = layers.BatchNormalization()(x)
    x = layers.Activation("relu")(x)
    for _ in range(4):
        x = layers.DepthwiseConv2D((3, 3), padding="same")(x)
        x = layers.BatchNormalization()(x)
        x = layers.Activation("relu")(x)
        x = layers.Conv2D(64, (1, 1), padding="same")(x)
        x = layers.BatchNormalization()(x)
        x = layers.Activation("relu")(x)
    # MLPerf pools over half the input's height and width: (24, 5) on the 25 × 5 map leaves 1 × 1.
    x = layers.AveragePooling2D(pool_size=(frames // 2, MFCCS // 2))(x)
    x = layers.Flatten()(x)
    out = layers.Dense(classes, activation="softmax")(x)
    return tf.keras.Model(inp, out)


def mfcc(pcm):
    """MFCCs of one clip (int16 samples), with tf.signal, shaped (frames, MFCCS, 1)."""
    import tensorflow as tf

    x = tf.constant(pcm.astype(np.float32) / 32768.0)
    frame, stride = int(RATE_HZ * FRAME_MS / 1000), int(RATE_HZ * STRIDE_MS / 1000)
    stft = tf.signal.stft(x, frame_length=frame, frame_step=stride, fft_length=512)
    mel = tf.signal.linear_to_mel_weight_matrix(MELS, stft.shape[-1], RATE_HZ, 20.0, 4000.0)
    logmel = tf.math.log(tf.tensordot(tf.abs(stft), mel, 1) + 1e-6)
    return tf.signal.mfccs_from_log_mel_spectrograms(logmel)[..., :MFCCS, tf.newaxis].numpy()


def dataset_clips(path, limit=200):
    manifest = json.loads((Path(path) / "manifest.json").read_text())
    if manifest.get("rateHz") != RATE_HZ:
        sys.exit(f"quantize: the dataset is at {manifest.get('rateHz')} Hz; this front end takes {RATE_HZ} Hz")
    clips = []
    for c in manifest["clips"][:limit]:
        with wave.open(str(Path(path) / c["file"])) as w:
            clips.append(np.frombuffer(w.readframes(w.getnframes()), dtype="<i2"))
    return manifest, clips


def representative(shape, clips):
    """The calibration set: MFCCs of the dataset's clips, or noise shaped like the input."""
    if clips:
        feats = [mfcc(c) for c in clips]
        return lambda: ([f[np.newaxis].astype(np.float32)] for f in feats)
    rng = np.random.default_rng(0)
    return lambda: ([rng.normal(0, 1, (1, *shape)).astype(np.float32)] for _ in range(100))


def tflm_arena(tflite_path):
    """The tensor arena TFLite Micro itself allocates for the model: its interpreter (the tflite-micro package, host
    build) prepares and runs the model once, and its recording allocator reports the arena used. On the 64-bit host
    its bookkeeping structs are larger than on a 32-bit MCU, so this is a little above the device's figure.
    None when the tflite-micro package isn't installed."""
    try:
        from tflite_micro.python.tflite_micro import runtime
    except ImportError:
        return None
    import os
    import tempfile

    arena = 4096
    while arena <= 4 * 1024 * 1024:
        try:
            interp = runtime.Interpreter.from_file(str(tflite_path), arena_size=arena)
            d = interp.get_input_details(0)
            interp.set_input(np.zeros(d["shape"], dtype=d["dtype"]), 0)
            interp.invoke()
            break
        except Exception:
            arena *= 2
    else:
        return None
    # print_allocations logs from C++ to stderr (file descriptor 2): capture it.
    fd, tmp = tempfile.mkstemp()
    sys.stderr.flush()
    saved = os.dup(2)
    os.dup2(fd, 2)
    try:
        interp.print_allocations()
        sys.stderr.flush()
    finally:
        os.dup2(saved, 2)
        os.close(saved)
        os.close(fd)
    text = Path(tmp).read_text()
    os.unlink(tmp)
    m = re.search(r"Arena allocation total (\d+) bytes", text)
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--keras")
    ap.add_argument("--dataset")
    ap.add_argument("--classes", type=int, default=12)
    a = ap.parse_args()
    import tensorflow as tf

    model = tf.keras.models.load_model(a.keras) if a.keras else reference_model(a.classes)
    shape = tuple(model.input_shape[1:])
    manifest, clips = dataset_clips(a.dataset) if a.dataset else (None, [])
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = representative(shape, clips)
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.int8
    conv.inference_output_type = tf.int8
    tflite = conv.convert()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.tflite").write_bytes(tflite)
    hexes = ",".join(f"0x{b:02x}" for b in tflite)
    (out / "model_data.cc").write_text(
        "// Generated by Bringup (py/quantize.py) from the converted model. Do not edit.\n"
        "#include <stdint.h>\n"
        f"alignas(16) extern const uint8_t g_model[] = {{{hexes}}};\n"
        f"extern const unsigned int g_model_len = {len(tflite)};\n"
    )
    interp = tf.lite.Interpreter(model_content=tflite)
    inp = interp.get_input_details()[0]
    facts = {
        "model": a.keras or "MLPerf Tiny DS-CNN keyword spotter (reference architecture, untrained)",
        "trained": bool(a.keras),
        "quantization": "int8",
        "weightsBytes": len(tflite),
        "inputShape": [int(x) for x in inp["shape"]],
        "inputDtype": np.dtype(inp["dtype"]).name,
        "params": int(model.count_params()),
        "arenaBytes": tflm_arena(out / "model.tflite"),
        "arenaMeasuredWith": "tflite-micro interpreter, host build (64-bit: slightly above a 32-bit MCU)",
        "calibration": f"{len(clips)} clips from {a.dataset}" if clips else "noise (no dataset given): the int8 ranges are not calibrated on real data",
        "dataset": {"pathHash": manifest["pathHash"], "revision": manifest["revision"], "clips": len(manifest["clips"])} if manifest else None,
        "tensorflow": tf.__version__,
    }
    (out / "model.json").write_text(json.dumps(facts, indent=2) + "\n")
    print(json.dumps(facts))


if __name__ == "__main__":
    main()
