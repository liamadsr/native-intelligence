// dial8-local-stt — the local-stt module sidecar.
//
// Wraps NVIDIA NeMo-Speech.cpp (streaming ASR + Sortformer diarization)
// through its public C ABI and speaks Dial8's local-module protocol v1 on
// stdin/stdout (see src-tauri/src/modules/protocol.rs):
//
//   frame  = kind:u8  length:u32le  payload
//   kind 1 = JSON message, kind 2 = audio (stream:u8, rate:u32le, f32le[])
//
// Session:
//   → hello {module, protocol, version}
//   ← configure {assets:{asr, diarizer}, streams:[{id,name}], language,
//                rnntRightContext, endpointing, speechContexts, warmup}
//   → ready                      (or error {message, fatal})
//   ← audio frames …             one recognition stream per configured id
//   → transcript {stream, message}   message = Deepgram-shaped Results /
//                                    SpeechStarted / UtteranceEnd
//   ← finalize {stream, seq?}    end the stream's current utterance now
//   → finalized {stream, seq?}       (see "Finalize" below)
//   ← finish                     flush every stream's tail, then exit
//   stdin EOF                    same as finish (the app went away)
//
// Finalize (voice turns, dictation stop). `stream` is a configured stream's
// name; `seq` is optional and echoed verbatim in the ack. The request is
// queued behind the audio already received for that stream, so it takes
// effect at the chunk boundary after that audio. The stream then:
//   1. decodes everything pushed so far (natural endpoints come out as usual);
//   2. pushes synthetic silence long enough for the model's lookahead to
//      decode the last real samples (the pad never shows on the clock: every
//      later time is shifted back by it, so times stay on the audio received);
//   3. forces an endpoint (nemo_speech_asr_stream_force_endpoint) and sends
//      the resulting final Results, marked "from_finalize": true;
//   4. sends finalized {stream, seq}.
// Words the engine decodes later from the rest of the pad (a late token of
// a word the finalize already closed, e.g. "'re" after "you") are dropped.
// Every Results for audio received before the finalize is sent before the
// ack; nothing sent after the ack (interim, final, SpeechStarted,
// UtteranceEnd) is about that audio. The ack replaces the utterance's
// pending UtteranceEnd. An unknown stream name gets a non-fatal
// error {message, fatal:false, request:"finalize", stream, seq?} instead.
//
// Results are shaped like Deepgram's so the web reuses its parser: `speaker`
// is 0-based, times are seconds on the stream's audio clock, and each final
// utterance is split into one Results per speaker run (the web labels a whole
// segment with its first word's speaker).

#include <nemo_speech/asr.h>
#include <nlohmann/json.hpp>

#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdarg>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;

namespace {

constexpr int kProtocolMajor = 1;
constexpr uint8_t kKindJson = 1;
constexpr uint8_t kKindAudio = 2;
constexpr uint32_t kMaxFrameBytes = 32u * 1024u * 1024u;
constexpr int32_t kModelRate = 16000;

// Force a final after this much continuous speech so segments (and speaker
// attribution, which the diarizer only keeps ~10–20 min of) stay current.
constexpr double kMaxUtteranceSec = 20.0;
// Deepgram's UtteranceEnd: a gap this long after the last finalized word.
constexpr double kUtteranceEndGapSec = 2.0;
// Interim results per stream, at most this often.
constexpr auto kInterimInterval = std::chrono::milliseconds(200);
// The cache-aware encoder emits (1 + rnntRightContext) frames of this length
// per chunk (0.56 s at the default right context of 6).
constexpr double kEncoderFrameSec = 0.08;
// Extra silence on top of two chunks when finalizing: the STFT's right edge
// (n_fft/2 = 16 ms) and the pre-encode cache, with margin.
constexpr double kFinalizePadMarginSec = 0.1;

// ---- framed I/O ------------------------------------------------------------

int g_out_fd = -1;  // the real stdout; fd 1 is redirected to stderr
std::mutex g_out_mu;

void
log(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void
log(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::vfprintf(stderr, fmt, ap);
    va_end(ap);
    std::fputc('\n', stderr);
    std::fflush(stderr);
}

bool
write_all(int fd, const void* data, size_t n) {
    const auto* p = static_cast<const uint8_t*>(data);
    while (n > 0) {
        const ssize_t w = ::write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR)
                continue;
            return false;
        }
        p += w;
        n -= static_cast<size_t>(w);
    }
    return true;
}

bool
read_exact(int fd, void* data, size_t n) {
    auto* p = static_cast<uint8_t*>(data);
    while (n > 0) {
        const ssize_t r = ::read(fd, p, n);
        if (r == 0)
            return false;  // EOF
        if (r < 0) {
            if (errno == EINTR)
                continue;
            return false;
        }
        p += r;
        n -= static_cast<size_t>(r);
    }
    return true;
}

void
send(const json& msg) {
    const std::string body = msg.dump(-1, ' ', false, json::error_handler_t::replace);
    uint8_t header[5];
    header[0] = kKindJson;
    const uint32_t len = static_cast<uint32_t>(body.size());
    std::memcpy(header + 1, &len, 4);  // little-endian on every supported host
    std::lock_guard<std::mutex> lock(g_out_mu);
    if (!write_all(g_out_fd, header, 5) || !write_all(g_out_fd, body.data(), body.size())) {
        // The app closed our stdout — nobody is listening any more.
        std::_Exit(0);
    }
}

void
send_error(const std::string& message, bool fatal) {
    send({{"type", "error"}, {"message", message}, {"fatal", fatal}});
}

struct InFrame {
    uint8_t kind = 0;
    std::vector<uint8_t> payload;
};

// false on EOF or a malformed stream (both end the session).
bool
read_frame(InFrame& f) {
    uint8_t header[5];
    if (!read_exact(STDIN_FILENO, header, 5))
        return false;
    uint32_t len;
    std::memcpy(&len, header + 1, 4);
    if (len > kMaxFrameBytes) {
        log("frame of %u bytes exceeds the limit", len);
        return false;
    }
    f.kind = header[0];
    f.payload.resize(len);
    return len == 0 || read_exact(STDIN_FILENO, f.payload.data(), len);
}

// ---- configuration -----------------------------------------------------------

struct SpeechContext {
    std::vector<std::string> phrases;
    std::vector<const char*> ptrs;
    float boost = 0;
};

struct Config {
    std::string asr_model;
    std::string diar_model;
    std::map<int, std::string> streams;  // id → "mic" / "system"
    std::string language = "en-US";
    int rnnt_right_context = 6;
    bool endpointing = true;
    int gpu = 0;  // Metal; -1 = CPU
    bool warmup = false;
    std::vector<SpeechContext> contexts;
};

Config
parse_config(const json& j) {
    Config c;
    const json assets = j.value("assets", json::object());
    c.asr_model = assets.value("asr", "");
    c.diar_model = assets.value("diarizer", "");
    for (const auto& s : j.value("streams", json::array()))
        c.streams[s.value("id", 0)] = s.value("name", "mic");
    c.language = j.value("language", c.language);
    c.rnnt_right_context = j.value("rnntRightContext", c.rnnt_right_context);
    c.endpointing = j.value("endpointing", c.endpointing);
    c.gpu = j.value("gpu", c.gpu);
    c.warmup = j.value("warmup", false);
    for (const auto& ctx : j.value("speechContexts", json::array())) {
        SpeechContext sc;
        for (const auto& p : ctx.value("phrases", json::array()))
            if (p.is_string())
                sc.phrases.push_back(p.get<std::string>());
        sc.boost = ctx.value("boost", 5.0f);
        if (!sc.phrases.empty())
            c.contexts.push_back(std::move(sc));
    }
    for (auto& sc : c.contexts)
        for (const auto& p : sc.phrases) sc.ptrs.push_back(p.c_str());
    return c;
}

// ---- recognizer --------------------------------------------------------------

nemo_speech_asr_recognizer*
create_recognizer(const Config& c, int gpu) {
    nemo_speech_asr_backend_config backend = {};
    backend.size = sizeof(backend);
    backend.gpu = gpu;

    nemo_speech_asr_model_config model = {};
    model.size = sizeof(model);
    model.path = c.asr_model.c_str();

    nemo_speech_asr_streaming_config streaming = {};
    streaming.size = sizeof(streaming);
    streaming.chunk_size = 0.16f;
    streaming.ctc_left_padding = 1.92f;
    streaming.ctc_right_padding = 1.92f;
    streaming.rnnt_right_context = c.rnnt_right_context;

    nemo_speech_asr_endpointing_config endpointing = {};
    endpointing.size = sizeof(endpointing);
    endpointing.enable = c.endpointing;
    endpointing.vad_based = false;
    endpointing.stop_history_eou_ms = 800;

    nemo_speech_asr_diar_config diar = {};
    diar.size = sizeof(diar);
    diar.model_path = c.diar_model.c_str();
    diar.left_context_frames = -1;  // model default (0 is a valid override)

    nemo_speech_asr_recognizer_config cfg = {};
    cfg.size = sizeof(cfg);
    cfg.backend = &backend;
    cfg.model = &model;
    cfg.streaming = &streaming;
    cfg.endpointing = &endpointing;
    if (!c.diar_model.empty())
        cfg.diar = &diar;

    nemo_speech_asr_recognizer* rec = nullptr;
    if (nemo_speech_asr_create(&cfg, &rec) != NEMO_SPEECH_ASR_OK) {
        log("recognizer (gpu=%d) failed: %s", gpu, nemo_speech_asr_last_error());
        return nullptr;
    }
    return rec;
}

nemo_speech_asr_recognition_options
stream_options(const Config& c, std::vector<nemo_speech_asr_speech_context>& contexts) {
    contexts.clear();
    for (const auto& sc : c.contexts) {
        nemo_speech_asr_speech_context ctx = {};
        ctx.size = sizeof(ctx);
        ctx.phrases = sc.ptrs.data();
        ctx.phrase_count = sc.ptrs.size();
        ctx.boost = sc.boost;
        contexts.push_back(ctx);
    }
    nemo_speech_asr_recognition_options o = nemo_speech_asr_recognition_options_default();
    o.language_code = c.language.c_str();
    o.interim_results = true;
    o.enable_word_time_offsets = true;
    o.enable_automatic_punctuation = true;
    o.enable_speaker_diarization = !c.diar_model.empty();
    // Interims need word timings: the web replaces an interim with the final
    // that starts within 0.5 s of it (patches/0001, pending upstream).
    o.interim_word_offsets = true;
    o.speech_contexts = contexts.empty() ? nullptr : contexts.data();
    o.speech_context_count = contexts.size();
    return o;
}

// ---- one recognition stream ----------------------------------------------------

struct Word {
    std::string text;
    double start = 0;
    double end = 0;
    float confidence = 0;
    int speaker = -1;  // 0-based; -1 = untagged
};

// Times on the engine's clock include the finalize padding pushed so far;
// `shift` (seconds) is subtracted so they stay on the received-audio clock.
// Words starting before `drop_before` (engine clock) are dropped and counted
// in `dropped`: they were decoded from padding (late tokens of audio that a
// finalize already closed), so they belong to no utterance still open.
std::vector<Word>
read_words(const nemo_speech_asr_result* res, double shift, double drop_before, size_t& dropped) {
    std::vector<Word> words;
    const size_t n = nemo_speech_asr_result_word_count(res, 0);
    words.reserve(n);
    for (size_t i = 0; i < n; i++) {
        Word w;
        const char* t = nemo_speech_asr_result_word_text(res, 0, i);
        w.text = t ? t : "";
        const double start = nemo_speech_asr_result_word_start_time(res, 0, i) / 1000.0;
        if (!w.text.empty() && start < drop_before) {
            dropped++;
            continue;
        }
        w.start = std::max(0.0, start - shift);
        w.end = std::max(0.0, nemo_speech_asr_result_word_end_time(res, 0, i) / 1000.0 - shift);
        w.confidence = nemo_speech_asr_result_word_confidence(res, 0, i);
        w.speaker = nemo_speech_asr_result_word_speaker_tag(res, 0, i) - 1;
        if (!w.text.empty())
            words.push_back(std::move(w));
    }
    // Untagged words (the diarizer hasn't covered them yet) inherit the
    // nearest earlier tag; leading ones take the first tag in the result.
    int carry = -1;
    for (const auto& w : words)
        if (w.speaker >= 0) {
            carry = w.speaker;
            break;
        }
    for (auto& w : words) {
        if (w.speaker >= 0)
            carry = w.speaker;
        else
            w.speaker = carry;
    }
    return words;
}

json
deepgram_results(const std::vector<Word>& words, size_t from, size_t to, bool is_final,
                 bool speech_final) {
    json jwords = json::array();
    std::string transcript;
    for (size_t i = from; i < to; i++) {
        const Word& w = words[i];
        json jw = {{"word", w.text},
                   {"punctuated_word", w.text},
                   {"start", w.start},
                   {"end", std::max(w.end, w.start)},
                   {"confidence", w.confidence}};
        if (w.speaker >= 0)
            jw["speaker"] = w.speaker;
        jwords.push_back(std::move(jw));
        if (!transcript.empty())
            transcript += ' ';
        transcript += w.text;
    }
    const double start = words[from].start;
    const double end = std::max(words[to - 1].end, start);
    return {{"type", "Results"},
            {"channel_index", {0, 1}},
            {"is_final", is_final},
            {"speech_final", speech_final},
            {"start", start},
            {"duration", end - start},
            {"channel", {{"alternatives", {{{"transcript", transcript}, {"words", jwords}}}}}}};
}

class Stream {
public:
    Stream(nemo_speech_asr_recognizer* rec, const Config& cfg, std::string name)
        : name_(std::move(name)),
          // Upstream's own end-of-stream flush pads a chunk plus a shift.
          finalize_pad_sec_(2.0 * (1 + std::max(0, cfg.rnnt_right_context)) * kEncoderFrameSec +
                            kFinalizePadMarginSec) {
        auto opts = stream_options(cfg, contexts_);
        if (nemo_speech_asr_streaming_recognize(rec, &opts, &stream_) != NEMO_SPEECH_ASR_OK) {
            error_ = nemo_speech_asr_last_error();
            stream_ = nullptr;
        }
    }

    ~Stream() {
        if (stream_)
            nemo_speech_asr_stream_close(stream_);
    }

    bool ok() const { return stream_ != nullptr; }
    const std::string& name() const { return name_; }
    const std::string& error() const { return error_; }

    void start() { worker_ = std::thread([this] { run(); }); }

    void push(std::vector<float> samples, int32_t rate) {
        Item item;
        item.samples = std::move(samples);
        item.rate = rate;
        enqueue(std::move(item));
    }

    // Queue a finalize behind the audio received so far; `seq` (null when
    // absent) is echoed in the ack.
    void finalize(json seq) {
        Item item;
        item.finalize = true;
        item.seq = std::move(seq);
        enqueue(std::move(item));
    }

    // Flush the tail and stop the worker (blocks until done).
    void finish() {
        {
            std::lock_guard<std::mutex> lock(mu_);
            finishing_ = true;
        }
        cv_.notify_one();
        if (worker_.joinable())
            worker_.join();
    }

private:
    // One queued input, in arrival order: audio, or a finalize marker.
    struct Item {
        std::vector<float> samples;
        int32_t rate = 0;
        bool finalize = false;
        json seq;
    };

    void enqueue(Item item) {
        {
            std::lock_guard<std::mutex> lock(mu_);
            queue_.push_back(std::move(item));
        }
        cv_.notify_one();
    }

    void push_audio(const float* samples, size_t n, int32_t rate) {
        if (nemo_speech_asr_stream_push_f32(stream_, samples, n, rate) != NEMO_SPEECH_ASR_OK) {
            send_error(std::string("push failed on ") + name_ + ": " + nemo_speech_asr_last_error(), true);
            std::_Exit(3);
        }
    }

    void run() {
        for (;;) {
            std::deque<Item> items;
            bool finishing;
            {
                std::unique_lock<std::mutex> lock(mu_);
                cv_.wait(lock, [this] { return !queue_.empty() || finishing_; });
                items.swap(queue_);
                finishing = finishing_;
            }
            for (auto& item : items) {
                if (item.finalize) {
                    do_finalize(item.seq);
                    continue;
                }
                const int32_t rate = item.rate > 0 ? item.rate : kModelRate;
                push_audio(item.samples.data(), item.samples.size(), rate);
                input_rate_ = rate;
                audio_sec_ += static_cast<double>(item.samples.size()) / rate;
            }
            drain();
            maybe_force_endpoint();
            maybe_utterance_end();
            if (finishing) {
                nemo_speech_asr_stream_finish(stream_);
                drain();
                return;
            }
        }
    }

    // See "Finalize" in the header comment. Runs on the worker thread, in
    // queue order, so every sample received before the request is pushed.
    void do_finalize(const json& seq) {
        drain();  // natural endpoints in the audio so far come out as usual
        double pad_sec = 0;
        if (input_rate_ > 0) {
            // The stream's input rate is fixed by its first push, so the pad
            // uses it too (upstream resamples it with the audio).
            const size_t n = static_cast<size_t>(finalize_pad_sec_ * input_rate_ + 0.5);
            const std::vector<float> silence(n, 0.0f);
            push_audio(silence.data(), silence.size(), input_rate_);
            pad_sec = static_cast<double>(n) / input_rate_;
        }
        if (nemo_speech_asr_stream_force_endpoint(stream_) != NEMO_SPEECH_ASR_OK)
            log("force endpoint failed on %s: %s", name_.c_str(), nemo_speech_asr_last_error());
        from_finalize_ = true;
        drain();  // the forced final (its words predate the pad: old shift)
        from_finalize_ = false;
        pad_sec_ += pad_sec;
        // Engine-clock end of the pad: anything decoded before it from now
        // on is a late token of audio this finalize closed.
        drop_before_ = audio_sec_ + pad_sec_;
        in_utterance_ = false;
        forced_ = false;
        last_interim_.clear();
        // The ack is the boundary: no UtteranceEnd for audio before it.
        utterance_end_pending_ = false;
        json ack = {{"type", "finalized"}, {"stream", name_}};
        if (!seq.is_null())
            ack["seq"] = seq;
        send(ack);
    }

    void drain() {
        nemo_speech_asr_result* res = nullptr;
        while (nemo_speech_asr_stream_next(stream_, &res) == NEMO_SPEECH_ASR_OK && res) {
            handle(res);
            nemo_speech_asr_result_destroy(res);
            res = nullptr;
        }
    }

    void emit(json message) {
        send({{"type", "transcript"}, {"stream", name_}, {"message", std::move(message)}});
    }

    void handle(const nemo_speech_asr_result* res) {
        const bool is_final = nemo_speech_asr_result_is_final(res);
        size_t dropped = 0;
        std::vector<Word> words = read_words(res, pad_sec_, drop_before_, dropped);
        if (dropped > 0 && is_final)  // (interims repeat the utterance so far)
            log("%s: dropped %zu word(s) decoded from finalize padding", name_.c_str(), dropped);

        if (!is_final) {
            if (words.empty())
                return;
            if (!in_utterance_) {
                in_utterance_ = true;
                utterance_audio_start_ = audio_sec_;
                forced_ = false;
                emit({{"type", "SpeechStarted"}, {"channel", {0, 1}}, {"timestamp", words.front().start}});
            }
            const char* t = nemo_speech_asr_result_transcript(res, 0);
            std::string text = t ? t : "";
            if (dropped > 0) {  // the engine's text still has them
                text.clear();
                for (const auto& w : words) text += (text.empty() ? "" : " ") + w.text;
            }
            const auto now = std::chrono::steady_clock::now();
            if (text == last_interim_ || now - last_interim_at_ < kInterimInterval)
                return;
            last_interim_ = text;
            last_interim_at_ = now;
            // Interims show the whole utterance so far under its first
            // speaker; the per-speaker split happens on the final.
            json msg = deepgram_results(words, 0, words.size(), false, false);
            msg["channel"]["alternatives"][0]["transcript"] = text;
            emit(std::move(msg));
            return;
        }

        in_utterance_ = false;
        last_interim_.clear();
        if (words.empty())
            return;
        size_t run_start = 0;
        for (size_t i = 1; i <= words.size(); i++) {
            if (i == words.size() || words[i].speaker != words[run_start].speaker) {
                json msg = deepgram_results(words, run_start, i, true, i == words.size());
                if (from_finalize_)
                    msg["from_finalize"] = true;  // Deepgram's name for it
                emit(std::move(msg));
                run_start = i;
            }
        }
        last_word_end_ = words.back().end;
        utterance_end_pending_ = true;
    }

    void maybe_force_endpoint() {
        if (in_utterance_ && !forced_ && audio_sec_ - utterance_audio_start_ > kMaxUtteranceSec) {
            forced_ = true;
            nemo_speech_asr_stream_force_endpoint(stream_);
            drain();
        }
    }

    void maybe_utterance_end() {
        if (utterance_end_pending_ && !in_utterance_ && audio_sec_ - last_word_end_ >= kUtteranceEndGapSec) {
            utterance_end_pending_ = false;
            emit({{"type", "UtteranceEnd"}, {"channel", {0, 1}}, {"last_word_end", last_word_end_}});
        }
    }

    std::string name_;
    std::string error_;
    nemo_speech_asr_stream* stream_ = nullptr;
    std::vector<nemo_speech_asr_speech_context> contexts_;

    const double finalize_pad_sec_;

    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<Item> queue_;
    bool finishing_ = false;
    std::thread worker_;

    // Worker-thread state.
    double audio_sec_ = 0;  // audio received (the pad is not counted)
    int32_t input_rate_ = 0;  // 0 until the first push
    double pad_sec_ = 0;    // finalize silence pushed so far
    double drop_before_ = 0;  // engine clock; see read_words
    bool from_finalize_ = false;
    bool in_utterance_ = false;
    bool forced_ = false;
    double utterance_audio_start_ = 0;
    double last_word_end_ = 0;
    bool utterance_end_pending_ = false;
    std::string last_interim_;
    std::chrono::steady_clock::time_point last_interim_at_{};
};

// Push a couple of seconds through a throwaway stream so the GPU kernels for
// the encoder and diarizer compile now rather than in the first meeting.
void
warm_up(nemo_speech_asr_recognizer* rec, const Config& cfg) {
    std::vector<nemo_speech_asr_speech_context> contexts;
    auto opts = stream_options(cfg, contexts);
    nemo_speech_asr_stream* s = nullptr;
    if (nemo_speech_asr_streaming_recognize(rec, &opts, &s) != NEMO_SPEECH_ASR_OK)
        return;
    std::vector<float> audio(kModelRate * 3);
    uint32_t seed = 12345;
    for (auto& x : audio) {  // quiet noise, so every stage does real work
        seed = seed * 1664525u + 1013904223u;
        x = (static_cast<float>(seed >> 8) / 16777216.0f - 0.5f) * 0.01f;
    }
    nemo_speech_asr_stream_push_f32(s, audio.data(), audio.size(), kModelRate);
    nemo_speech_asr_result* res = nullptr;
    while (nemo_speech_asr_stream_next(s, &res) == NEMO_SPEECH_ASR_OK && res) {
        nemo_speech_asr_result_destroy(res);
        res = nullptr;
    }
    nemo_speech_asr_stream_finish(s);
    while (nemo_speech_asr_stream_next(s, &res) == NEMO_SPEECH_ASR_OK && res) {
        nemo_speech_asr_result_destroy(res);
        res = nullptr;
    }
    nemo_speech_asr_stream_close(s);
}

}  // namespace

int
main() {
    std::signal(SIGPIPE, SIG_IGN);
    // Keep protocol frames on the real stdout and send anything a library
    // prints to stdout to stderr instead, where it becomes a log line.
    g_out_fd = ::dup(STDOUT_FILENO);
    ::dup2(STDERR_FILENO, STDOUT_FILENO);

    send({{"type", "hello"},
          {"module", "local-stt"},
          {"protocol", kProtocolMajor},
          {"version", std::string(nemo_speech_asr_version()) + "+" + NEMO_UPSTREAM_SHA}});

    // Wait for configure.
    InFrame frame;
    json configure;
    for (;;) {
        if (!read_frame(frame))
            return 0;
        if (frame.kind != kKindJson)
            continue;
        json msg = json::parse(frame.payload.begin(), frame.payload.end(), nullptr, false);
        if (msg.is_discarded())
            continue;
        const std::string type = msg.value("type", "");
        if (type == "configure") {
            configure = std::move(msg);
            break;
        }
        if (type == "shutdown")
            return 0;
    }

    Config cfg = parse_config(configure);
    if (cfg.asr_model.empty()) {
        send_error("configure is missing assets.asr", true);
        return 2;
    }

    const auto t0 = std::chrono::steady_clock::now();
    nemo_speech_asr_recognizer* rec = create_recognizer(cfg, cfg.gpu);
    if (!rec && cfg.gpu >= 0) {
        log("GPU unavailable — falling back to CPU");
        rec = create_recognizer(cfg, -1);
    }
    if (!rec) {
        send_error(std::string("could not load the speech model: ") + nemo_speech_asr_last_error(), true);
        return 2;
    }
    log("models loaded in %.2fs (%s)",
        std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count(),
        nemo_speech_asr_version());

    if (cfg.warmup) {
        const auto w0 = std::chrono::steady_clock::now();
        warm_up(rec, cfg);
        log("warm-up pass took %.2fs",
            std::chrono::duration<double>(std::chrono::steady_clock::now() - w0).count());
        send({{"type", "ready"}});
        while (read_frame(frame)) {
        }
        nemo_speech_asr_destroy(rec);
        return 0;
    }

    std::map<int, std::unique_ptr<Stream>> streams;
    for (const auto& [id, name] : cfg.streams) {
        auto s = std::make_unique<Stream>(rec, cfg, name);
        if (!s->ok()) {
            send_error("could not open the " + name + " stream: " + s->error(), true);
            // Join the workers already running before their Streams are
            // destroyed (a joinable std::thread would std::terminate).
            for (auto& entry : streams) entry.second->finish();
            streams.clear();
            nemo_speech_asr_destroy(rec);
            return 2;
        }
        s->start();
        streams[id] = std::move(s);
    }
    send({{"type", "ready"}});

    for (;;) {
        if (!read_frame(frame))
            break;  // EOF: the app stopped or went away — flush and exit
        if (frame.kind == kKindAudio) {
            if (frame.payload.size() < 5 || (frame.payload.size() - 5) % 4 != 0)
                continue;
            const int id = frame.payload[0];
            int32_t rate;
            std::memcpy(&rate, frame.payload.data() + 1, 4);
            auto it = streams.find(id);
            if (it == streams.end())
                continue;
            std::vector<float> samples((frame.payload.size() - 5) / 4);
            std::memcpy(samples.data(), frame.payload.data() + 5, samples.size() * 4);
            it->second->push(std::move(samples), rate);
        } else if (frame.kind == kKindJson) {
            json msg = json::parse(frame.payload.begin(), frame.payload.end(), nullptr, false);
            const std::string type = msg.is_discarded() ? "" : msg.value("type", "");
            if (type == "finish")
                break;
            if (type == "shutdown")
                std::_Exit(0);
            if (type == "ping")
                send({{"type", "pong"}});
            if (type == "finalize") {
                // Checked by hand: value() throws on a mistyped field.
                const std::string name =
                    msg.contains("stream") && msg["stream"].is_string() ? msg["stream"].get<std::string>() : "";
                json seq = msg.contains("seq") ? msg["seq"] : json();
                auto it = std::find_if(streams.begin(), streams.end(),
                                       [&](const auto& entry) { return entry.second->name() == name; });
                if (it != streams.end()) {
                    it->second->finalize(std::move(seq));
                } else {
                    json err = {{"type", "error"},
                                {"message", "finalize: no stream named \"" + name + "\""},
                                {"fatal", false},
                                {"request", "finalize"},
                                {"stream", name}};
                    if (!seq.is_null())
                        err["seq"] = seq;
                    send(err);
                }
            }
        }
    }

    for (auto& [id, s] : streams) s->finish();
    streams.clear();
    nemo_speech_asr_destroy(rec);
    log("finished");
    return 0;
}
