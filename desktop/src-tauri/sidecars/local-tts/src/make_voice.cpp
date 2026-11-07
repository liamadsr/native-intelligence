// dial8-tts-make-voice — developer tool behind voices/make-voice.sh. Encodes a
// voice recording into a .emb voice embedding with the Mimi encoder, exactly
// as PocketTTS.cpp encodes a WAV voice at runtime (mono, resampled to 24 kHz,
// at most 30 s). build.sh leaves it in .out/tools/; it is never shipped, and
// neither is the encoder: that is what clones a voice.
//
//   dial8-tts-make-voice --encoder mimi_encoder.onnx --in voice.wav --out voice.emb [--threads N]

#include "pocket_tts_api.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

int
main(int argc, char** argv) {
    std::string encoder, in, out;
    int threads = 4;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (i + 1 >= argc) {
            std::fprintf(stderr, "missing value for %s\n", a.c_str());
            return 2;
        }
        if (a == "--encoder")
            encoder = argv[++i];
        else if (a == "--in")
            in = argv[++i];
        else if (a == "--out")
            out = argv[++i];
        else if (a == "--threads")
            threads = std::atoi(argv[++i]);
        else {
            std::fprintf(stderr, "unknown option %s\n", a.c_str());
            return 2;
        }
    }
    if (encoder.empty() || in.empty() || out.empty()) {
        std::fprintf(stderr, "usage: %s --encoder mimi_encoder.onnx --in voice.wav --out voice.emb [--threads N]\n",
                     argv[0]);
        return 2;
    }
    if (ptt_encode_voice(encoder.c_str(), in.c_str(), out.c_str(), threads) != 0)
        return 1;

    // Report what was written: "EMB1", ndims:i32, shape:i64[ndims], f32[].
    FILE* f = std::fopen(out.c_str(), "rb");
    char magic[4] = {};
    int32_t ndims = 0;
    int64_t shape[3] = {};
    const bool ok = f && std::fread(magic, 1, 4, f) == 4 && std::memcmp(magic, "EMB1", 4) == 0 &&
                    std::fread(&ndims, 4, 1, f) == 1 && ndims == 3 && std::fread(shape, 8, 3, f) == 3;
    if (f)
        std::fclose(f);
    if (!ok) {
        std::fprintf(stderr, "%s is not a [1, frames, dim] embedding\n", out.c_str());
        return 1;
    }
    // Mimi runs at 12.5 frames per second.
    std::printf("%s: %lld frames x %lld (%.1f s of voice)\n", out.c_str(), (long long)shape[1], (long long)shape[2],
                shape[1] / 12.5);
    return 0;
}
