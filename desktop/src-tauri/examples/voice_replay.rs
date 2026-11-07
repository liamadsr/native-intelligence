//! Chat voice replay harness (noise design §3.2). See `src/voice/replay.rs`.
//!
//! ```text
//! cargo run --example voice_replay -- sim [--profile quiet|noisy] [--scene NAME]
//! cargo run --example voice_replay -- capture DIR [--profile quiet|noisy] [--full]
//! cargo run --example voice_replay -- capture DIR --closed [--profile quiet|noisy] [--hint DB|remember]
//! cargo run --example voice_replay -- goldens [--write]
//! cargo run --example voice_replay -- fixture DIR NAME [--write]
//! ```

fn main() {
    std::process::exit(dial8_desktop_lib::voice_replay_main(std::env::args().skip(1).collect()));
}
