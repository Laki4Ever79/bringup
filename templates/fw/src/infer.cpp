// Model check on the target (env esp32c3_infer): the converted model (py/quantize.py's model_data.cc) is run once by
// TensorFlow Lite Micro on the design's MCU, which reports the tensor arena it really used. The arena here is
// deliberately generous, so the figure is a measurement, not a pass/fail of the plan; `bringup verify-model --device`
// compares it with the contract's arena. Run in QEMU, which reads UART0. The input is zeros: this checks that the
// model loads, its ops resolve and it runs on this chip, not what it answers.
//
// One line: BRINGUP-INFER ok arena_used=<B> arena=<B> input=<B> output=<B> ops=<n>
//       or: BRINGUP-INFER FAIL <reason>
#ifdef INFER
#include <Arduino.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/schema/schema_generated.h>
#include "model.h"

#if !__has_include("model_data.h")
#error "the model check needs the converted model (bringup verify-model --device links model_data.cc)"
#endif
#include "model_data.h"

// Four times the planned arena, at least 64 KB: room to measure a model the plan underestimates.
static const size_t INFER_ARENA_BYTES = (4 * MODEL_ARENA_BYTES > 65536 ? 4 * MODEL_ARENA_BYTES : 65536);
alignas(16) static uint8_t arena[INFER_ARENA_BYTES];

// The builtin ops small int8 audio and motion models use (TFLite converter output for Keras conv/dense models).
static const int OPS = 15;

void setup() {
	Serial.begin(115200);
	delay(100);
	const tflite::Model *model = tflite::GetModel(g_model);
	if (model->version() != TFLITE_SCHEMA_VERSION) {
		Serial.printf("BRINGUP-INFER FAIL schema version %lu, this TFLite Micro reads %d\n", (unsigned long)model->version(), TFLITE_SCHEMA_VERSION);
		return;
	}
	static tflite::MicroMutableOpResolver<OPS> ops;
	ops.AddConv2D();
	ops.AddDepthwiseConv2D();
	ops.AddAveragePool2D();
	ops.AddMaxPool2D();
	ops.AddFullyConnected();
	ops.AddSoftmax();
	ops.AddReshape();
	ops.AddAdd();
	ops.AddMul();
	ops.AddRelu();
	ops.AddQuantize();
	ops.AddDequantize();
	ops.AddMean();
	ops.AddPad();
	ops.AddLogistic();
	static tflite::MicroInterpreter interp(model, ops, arena, INFER_ARENA_BYTES);
	if (interp.AllocateTensors() != kTfLiteOk) {
		Serial.printf("BRINGUP-INFER FAIL allocate: the model needs more than %u B of arena, or an op this check doesn't register\n", (unsigned)INFER_ARENA_BYTES);
		return;
	}
	TfLiteTensor *in = interp.input(0);
	memset(in->data.raw, 0, in->bytes);
	if (interp.Invoke() != kTfLiteOk) {
		Serial.println("BRINGUP-INFER FAIL invoke");
		return;
	}
	Serial.printf("BRINGUP-INFER ok arena_used=%u arena=%u input=%u output=%u ops=%u\n", (unsigned)interp.arena_used_bytes(), (unsigned)INFER_ARENA_BYTES, (unsigned)in->bytes, (unsigned)interp.output(0)->bytes, (unsigned)model->subgraphs()->Get(0)->operators()->size());
}

void loop() {
	delay(1000);
}
#endif
