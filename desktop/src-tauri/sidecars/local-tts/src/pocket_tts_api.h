// The C API of PocketTTS.cpp (upstream/pocket_tts.cpp with patches/ applied),
// as dial8-local-tts uses it. Upstream ships no header, so this is ours.
//
// CMakeLists.txt force-includes this file into pocket_tts.cpp: if an upstream
// bump changes one of these signatures, compiling upstream fails ("conflicting
// declaration of C function") instead of the wrapper calling it with the
// wrong arguments.
#pragma once

#include <cstdint>

extern "C" {

// Every model file named explicitly (patches/0004). mimi_encoder and
// bos_before_voice may be NULL: they are then looked for next to flow_lm_main
// (the encoder only when a WAV voice is asked for). NULL on failure.
void* ptt_create_from_files(const char* text_conditioner, const char* flow_lm_main,
                            const char* flow_lm_flow, const char* mimi_decoder,
                            const char* mimi_encoder, const char* tokenizer_path,
                            const char* bos_before_voice,
                            float temperature, int lsd_steps, int num_threads);
double ptt_warmup(void* handle);
// Generation options by name (patches/0005); 0 on success, -1 for an unknown
// name. Set before streaming, not while a stream runs.
int ptt_set_option(void* handle, const char* name, double value);
// The last finished stream: sentences generated, and how many ran to their
// frame cap without the model ending them (patches/0005). After
// ptt_stream_end.
void ptt_last_stats(void* handle, int* sentences, int* capped);
void ptt_destroy(void* handle);

// A voice from a precomputed embedding ([1, frames, dim] float32), used by
// name in ptt_stream_start; no WAV, no encoder (patches/0003). 0 on success.
int ptt_add_voice(void* handle, const char* name, const float* data, const int64_t* shape, int ndims);
// Encodes a clip into a .emb file with mimi_encoder.onnx (patches/0003). Dev
// tool only: dial8-tts-make-voice. 0 on success.
int ptt_encode_voice(const char* encoder_path, const char* audio_path, const char* emb_path, int num_threads);

// Streaming: start, read chunks until 0, end. ptt_stream_cancel stops a
// stream from any thread within about a frame (patches/0002); the reading
// thread still calls ptt_stream_end.
void* ptt_stream_start(void* handle, const char* text, const char* voice);
int ptt_stream_read(void* stream_ctx, float** out_samples, int* out_len);
void ptt_stream_cancel(void* stream_ctx);
void ptt_stream_end(void* stream_ctx);
void ptt_free_audio(float* samples);

}  // extern "C"
