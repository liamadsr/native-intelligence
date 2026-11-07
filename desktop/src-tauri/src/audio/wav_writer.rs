use hound::{WavSpec, WavWriter as HoundWriter};
use std::path::{Path, PathBuf};

pub struct WavWriter {
    writer: HoundWriter<std::io::BufWriter<std::fs::File>>,
    path: PathBuf,
}

impl WavWriter {
    pub fn new(path: &Path, sample_rate: u32, channels: u16) -> Result<Self, hound::Error> {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let writer = HoundWriter::create(path, spec)?;
        Ok(Self {
            writer,
            path: path.to_path_buf(),
        })
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<(), hound::Error> {
        for &sample in samples {
            self.writer.write_sample(sample)?;
        }
        Ok(())
    }

    pub fn finalize(self) -> Result<PathBuf, hound::Error> {
        self.writer.finalize()?;
        Ok(self.path)
    }
}
