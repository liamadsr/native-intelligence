// A plain-colour video made in code, for a blank canvas (a film built only from layers). The app has no FFmpeg,
// and a canvas is the simplest video there is, so it is written here directly: H.264 (Constrained Baseline) in an
// MP4. The first frame stores its pixels as they are (I_PCM blocks of 16×16 pixels), every later frame repeats it (every
// block skipped), so a 20 second canvas is a few tens of kilobytes. It is encoded small, at the same shape as
// the edit: a plain colour scales up without any loss, and the editor fits it to the frame.
//
// Colours are BT.709, limited range, and the stream says so, so browsers and the render show the hex asked for.

/** The size a canvas is encoded at: the edit's exact shape, about 256 px on its long side, both sides even. */
export function canvasSize(width: number, height: number): { width: number; height: number } {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(width, height)
  const rw = width / g
  const rh = height / g
  let k = Math.max(1, Math.floor(256 / Math.max(rw, rh)))
  if ((rw % 2 || rh % 2) && k % 2) k = k > 1 ? k - 1 : 2
  const w = rw * k
  const h = rh * k
  // An awkward shape has no small exact size: keep the edit's own (still one picture, then skips).
  if (w > 4096 || h > 4096 || w % 2 || h % 2 || w < 16 || h < 16) return { width, height }
  return { width: w, height: h }
}

/** A #rrggbb colour as limited-range BT.709 Y, Cb, Cr. */
export function yuv709(hex: string): { y: number; cb: number; cr: number } {
  const n = parseInt(hex.slice(1, 7), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const cb = (b - y) / 1.8556
  const cr = (r - y) / 1.5748
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))
  return { y: clamp(16 + 219 * y, 16, 235), cb: clamp(128 + 224 * cb, 16, 240), cr: clamp(128 + 224 * cr, 16, 240) }
}

class Bits {
  private out: number[] = []
  private cur = 0
  private n = 0
  bit(b: number) {
    this.cur = (this.cur << 1) | (b & 1)
    if (++this.n === 8) {
      this.out.push(this.cur)
      this.cur = 0
      this.n = 0
    }
  }
  u(bits: number, value: number) {
    for (let i = bits - 1; i >= 0; i--) this.bit(Math.floor(value / 2 ** i) % 2)
  }
  ue(value: number) {
    const x = value + 1
    const len = Math.floor(Math.log2(x))
    this.u(len, 0)
    this.u(len + 1, x)
  }
  se(value: number) {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1)
  }
  align() {
    while (this.n) this.bit(0)
  }
  trailing() {
    this.bit(1)
    this.align()
  }
  bytes() {
    if (this.n) throw new Error('Bit writer is not byte aligned')
    return Uint8Array.from(this.out)
  }
}

/** A NAL unit: its header byte, then the payload with emulation-prevention bytes inserted. */
function nal(refIdc: number, type: number, rbsp: Uint8Array): Uint8Array {
  const out: number[] = [(refIdc << 5) | type]
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

function level(mbs: number, fps: number): number {
  const rate = mbs * fps
  if (mbs <= 1620 && rate <= 40_500) return 30
  if (mbs <= 3600 && rate <= 108_000) return 31
  if (mbs <= 8192 && rate <= 245_760) return 40
  return 51
}

function sps(mbw: number, mbh: number, width: number, height: number, levelIdc: number): Uint8Array {
  const b = new Bits()
  b.u(8, 66) // Baseline
  b.u(8, 0xc0) // constraint_set0 and set1: Constrained Baseline
  b.u(8, levelIdc)
  b.ue(0) // seq_parameter_set_id
  b.ue(0) // log2_max_frame_num_minus4: frame_num counts 0..15
  b.ue(2) // pic_order_cnt_type 2: output order is decode order
  b.ue(1) // max_num_ref_frames
  b.u(1, 0) // gaps_in_frame_num_value_allowed_flag
  b.ue(mbw - 1)
  b.ue(mbh - 1)
  b.u(1, 1) // frame_mbs_only_flag
  b.u(1, 1) // direct_8x8_inference_flag
  const cropRight = (mbw * 16 - width) / 2
  const cropBottom = (mbh * 16 - height) / 2
  if (cropRight || cropBottom) {
    b.u(1, 1)
    b.ue(0)
    b.ue(cropRight)
    b.ue(0)
    b.ue(cropBottom)
  } else b.u(1, 0)
  b.u(1, 1) // vui_parameters_present_flag
  b.u(1, 0) // aspect_ratio_info_present_flag
  b.u(1, 0) // overscan_info_present_flag
  b.u(1, 1) // video_signal_type_present_flag
  b.u(3, 5) // video_format: unspecified
  b.u(1, 0) // limited range
  b.u(1, 1) // colour_description_present_flag
  b.u(8, 1) // BT.709 primaries
  b.u(8, 1) // BT.709 transfer
  b.u(8, 1) // BT.709 matrix
  b.u(1, 0) // chroma_loc_info_present_flag
  b.u(1, 0) // timing_info_present_flag (the MP4 has the timing)
  b.u(1, 0) // nal_hrd_parameters_present_flag
  b.u(1, 0) // vcl_hrd_parameters_present_flag
  b.u(1, 0) // pic_struct_present_flag
  b.u(1, 1) // bitstream_restriction_flag: no reordering, show each frame as it is decoded
  b.u(1, 1) // motion_vectors_over_pic_boundaries_flag
  b.ue(0) // max_bytes_per_pic_denom
  b.ue(0) // max_bits_per_mb_denom
  b.ue(15) // log2_max_mv_length_horizontal
  b.ue(15) // log2_max_mv_length_vertical
  b.ue(0) // max_num_reorder_frames
  b.ue(1) // max_dec_frame_buffering
  b.trailing()
  return nal(3, 7, b.bytes())
}

function pps(): Uint8Array {
  const b = new Bits()
  b.ue(0) // pic_parameter_set_id
  b.ue(0) // seq_parameter_set_id
  b.u(1, 0) // CAVLC
  b.u(1, 0) // bottom_field_pic_order_in_frame_present_flag
  b.ue(0) // num_slice_groups_minus1
  b.ue(0) // num_ref_idx_l0_default_active_minus1
  b.ue(0) // num_ref_idx_l1_default_active_minus1
  b.u(1, 0) // weighted_pred_flag
  b.u(2, 0) // weighted_bipred_idc
  b.se(0) // pic_init_qp_minus26
  b.se(0) // pic_init_qs_minus26
  b.se(0) // chroma_qp_index_offset
  b.u(1, 1) // deblocking_filter_control_present_flag
  b.u(1, 0) // constrained_intra_pred_flag
  b.u(1, 0) // redundant_pic_cnt_present_flag
  b.trailing()
  return nal(3, 8, b.bytes())
}

/** The first frame: every 16×16 block stores its pixels as is (I_PCM), all one colour. */
function idrSlice(mbs: number, color: { y: number; cb: number; cr: number }): Uint8Array {
  const b = new Bits()
  b.ue(0) // first_mb_in_slice
  b.ue(7) // slice_type: I, all slices
  b.ue(0) // pic_parameter_set_id
  b.u(4, 0) // frame_num
  b.ue(0) // idr_pic_id
  b.u(1, 0) // no_output_of_prior_pics_flag
  b.u(1, 0) // long_term_reference_flag
  b.se(0) // slice_qp_delta
  b.ue(1) // disable_deblocking_filter_idc: off
  for (let mb = 0; mb < mbs; mb++) {
    b.ue(25) // mb_type I_PCM
    b.align() // pcm_alignment_zero_bit
    for (let i = 0; i < 256; i++) b.u(8, color.y)
    for (let i = 0; i < 64; i++) b.u(8, color.cb)
    for (let i = 0; i < 64; i++) b.u(8, color.cr)
  }
  b.trailing()
  return nal(3, 5, b.bytes())
}

/** A later frame: every 16×16 block skipped, so it repeats the frame before. */
function skipSlice(mbs: number, frameNum: number): Uint8Array {
  const b = new Bits()
  b.ue(0) // first_mb_in_slice
  b.ue(5) // slice_type: P, all slices
  b.ue(0) // pic_parameter_set_id
  b.u(4, frameNum % 16) // frame_num
  b.u(1, 0) // num_ref_idx_active_override_flag
  b.u(1, 0) // ref_pic_list_modification_flag_l0
  b.u(1, 0) // adaptive_ref_pic_marking_mode_flag
  b.se(0) // slice_qp_delta
  b.ue(1) // disable_deblocking_filter_idc: off
  b.ue(mbs) // mb_skip_run: the whole frame
  b.trailing()
  return nal(2, 1, b.bytes())
}

// ---- MP4 ---------------------------------------------------------------------------------------------------

const u32 = (v: number) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)
const u16 = (v: number) => Uint8Array.of((v >>> 8) & 255, v & 255)
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
const zeros = (n: number) => new Uint8Array(n)

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

const box = (type: string, ...payload: Uint8Array[]) => {
  const body = join(payload)
  return join([u32(body.byteLength + 8), ascii(type), body])
}
const fullBox = (type: string, version: number, flags: number, ...payload: Uint8Array[]) =>
  box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload)

const MATRIX = join([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)])

function moov(o: { width: number; height: number; fps: number; frames: number; sizes: number[]; chunkOffset: number; sps: Uint8Array; pps: Uint8Array; levelIdc: number }) {
  const timescale = o.fps * 1000
  const mediaDuration = o.frames * 1000
  const movieDuration = Math.round((o.frames / o.fps) * 1000)
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2))
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(o.width * 65536), u32(o.height * 65536))
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0))
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), zeros(1))
  const vmhd = fullBox('vmhd', 0, 1, zeros(8))
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)))
  const avcC = box('avcC', Uint8Array.of(1, 66, 0xc0, o.levelIdc, 0xff, 0xe1), u16(o.sps.byteLength), o.sps, Uint8Array.of(1), u16(o.pps.byteLength), o.pps)
  const avc1 = box('avc1', zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(o.width), u16(o.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), avcC)
  const stsd = fullBox('stsd', 0, 0, u32(1), avc1)
  const stts = fullBox('stts', 0, 0, u32(1), u32(o.frames), u32(1000))
  const stss = fullBox('stss', 0, 0, u32(1), u32(1))
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(o.frames), u32(1))
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(o.frames), ...o.sizes.map(u32))
  const stco = fullBox('stco', 0, 0, u32(1), u32(o.chunkOffset))
  const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco)
  const minf = box('minf', vmhd, dinf, stbl)
  const mdia = box('mdia', mdhd, hdlr, minf)
  return box('moov', mvhd, box('trak', tkhd, mdia))
}

/** A plain-colour MP4: `width`×`height` (even), `fps` frames a second, `frames` frames, colour `#rrggbb`. */
export function canvasMp4(o: { width: number; height: number; fps: number; frames: number; color: string }): Uint8Array {
  if (o.width % 2 || o.height % 2 || o.width < 2 || o.height < 2) throw new Error('A canvas has even sides')
  if (!Number.isInteger(o.fps) || o.fps < 1 || o.fps > 60) throw new Error('A canvas runs at 1 to 60 frames a second')
  if (!Number.isInteger(o.frames) || o.frames < 1) throw new Error('A canvas has at least one frame')
  const mbw = Math.ceil(o.width / 16)
  const mbh = Math.ceil(o.height / 16)
  const mbs = mbw * mbh
  const levelIdc = level(mbs, o.fps)
  const spsNal = sps(mbw, mbh, o.width, o.height, levelIdc)
  const ppsNal = pps()
  const first = idrSlice(mbs, yuv709(o.color))
  const skips = Array.from({ length: 16 }, (_, n) => skipSlice(mbs, n))
  const samples: Uint8Array[] = []
  for (let i = 0; i < o.frames; i++) {
    const unit = i === 0 ? first : skips[i % 16]!
    samples.push(join([u32(unit.byteLength), unit]))
  }
  const sizes = samples.map((s) => s.byteLength)
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'))
  const draft = moov({ width: o.width, height: o.height, fps: o.fps, frames: o.frames, sizes, chunkOffset: 0, sps: spsNal, pps: ppsNal, levelIdc })
  const chunkOffset = ftyp.byteLength + draft.byteLength + 8
  const header = moov({ width: o.width, height: o.height, fps: o.fps, frames: o.frames, sizes, chunkOffset, sps: spsNal, pps: ppsNal, levelIdc })
  const mdat = box('mdat', ...samples)
  return join([ftyp, header, mdat])
}
