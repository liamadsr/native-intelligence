/// Captures audio from a pre-created aggregate device and streams
/// 16kHz mono PCM float32 to stdout.
///
/// The tap and aggregate device are created by the parent Rust process
/// (which has Screen & System Audio Recording permission).
/// This class just reads from the device via IO proc.

import Foundation
import AVFoundation
import CoreAudio

@available(macOS 14.4, *)
class DeviceAudioCapture {
    private let deviceUID: String
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?

    private var nativeFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    /// Persistent, sample-exact converter to the 16 kHz mono output. Used only
    /// on `processingQueue`.
    private var resampler: StreamingResampler?

    private let processingQueue = DispatchQueue(label: "com.dial8.device-capture", qos: .userInteractive)
    private var isActive = false

    init(deviceUID: String) {
        self.deviceUID = deviceUID
    }

    func start() throws {
        // Find the aggregate device by UID
        aggregateDeviceID = try findDeviceByUID(deviceUID)

        guard aggregateDeviceID != kAudioObjectUnknown else {
            throw CaptureError.deviceNotFound
        }

        fputs("[DeviceAudioCapture] Found device ID: \(aggregateDeviceID) for UID: \(deviceUID)\n", stderr)

        try setupAudioFormat()
        try startIOProc()

        isActive = true
        fputs("CAPTURE_STARTED\n", stderr)
    }

    func stop() {
        isActive = false

        if let ioProcID = ioProcID, aggregateDeviceID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }

        processingQueue.sync(flags: .barrier) {}
        fputs("CAPTURE_STOPPED\n", stderr)
    }

    // MARK: - Find device

    private func findDeviceByUID(_ uid: String) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var deviceID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var cfUID = uid as CFString

        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<CFString>.size), &cfUID,
            &size, &deviceID
        )

        if status != noErr || deviceID == AudioObjectID(kAudioObjectUnknown) {
            throw CaptureError.deviceNotFound
        }

        return deviceID
    }

    // MARK: - Audio Format

    private func setupAudioFormat() throws {
        var asbd = AudioStreamBasicDescription()
        var propertySize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)

        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var status = AudioObjectGetPropertyData(
            aggregateDeviceID, &address, 0, nil, &propertySize, &asbd
        )

        if status != noErr || asbd.mSampleRate <= 0 {
            // Fallback
            asbd.mSampleRate = 48000
            asbd.mFormatID = kAudioFormatLinearPCM
            asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
            asbd.mBitsPerChannel = 32
            asbd.mChannelsPerFrame = 2
            asbd.mFramesPerPacket = 1
            asbd.mBytesPerFrame = 8
            asbd.mBytesPerPacket = 8
        }

        fputs("[DeviceAudioCapture] Native format: \(asbd.mSampleRate)Hz, \(asbd.mChannelsPerFrame)ch\n", stderr)

        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CaptureError.formatSetupFailed
        }
        self.nativeFormat = format

        guard let whisperFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ) else {
            throw CaptureError.formatSetupFailed
        }
        self.outputFormat = whisperFormat

        guard let resampler = StreamingResampler(from: format, to: whisperFormat) else {
            throw CaptureError.formatSetupFailed
        }
        self.resampler = resampler
    }

    // MARK: - IO Proc

    private func startIOProc() throws {
        guard let nativeFormat = nativeFormat,
              let resampler = resampler else {
            throw CaptureError.formatSetupFailed
        }

        var procID: AudioDeviceIOProcID?

        let status = AudioDeviceCreateIOProcIDWithBlock(
            &procID,
            aggregateDeviceID,
            nil
        ) { [weak self] _, inInputData, _, _, _ in
            guard let self = self, self.isActive else { return }

            let bufferList = inInputData.pointee
            guard bufferList.mNumberBuffers > 0 else { return }

            let buffer = bufferList.mBuffers
            guard let dataPtr = buffer.mData, buffer.mDataByteSize > 0 else { return }

            let byteSize = Int(buffer.mDataByteSize)

            let dataCopy = UnsafeMutableRawPointer.allocate(byteCount: byteSize, alignment: MemoryLayout<Float>.alignment)
            memcpy(dataCopy, dataPtr, byteSize)

            self.processingQueue.async {
                defer { dataCopy.deallocate() }
                self.processAudioBuffer(
                    dataPtr: dataCopy,
                    byteSize: byteSize,
                    nativeFormat: nativeFormat,
                    resampler: resampler
                )
            }
        }

        guard status == noErr, let validProcID = procID else {
            throw CaptureError.coreAudioError(status)
        }

        self.ioProcID = validProcID

        let startStatus = AudioDeviceStart(aggregateDeviceID, validProcID)
        guard startStatus == noErr else {
            throw CaptureError.coreAudioError(startStatus)
        }
    }

    // MARK: - Audio Processing

    private func processAudioBuffer(
        dataPtr: UnsafeMutableRawPointer,
        byteSize: Int,
        nativeFormat: AVAudioFormat,
        resampler: StreamingResampler
    ) {
        let bytesPerFrame = UInt32(nativeFormat.streamDescription.pointee.mBytesPerFrame)
        let frameCount = UInt32(byteSize) / max(bytesPerFrame, 1)
        guard frameCount > 0 else { return }

        guard let inputBuffer = AVAudioPCMBuffer(pcmFormat: nativeFormat, frameCapacity: frameCount) else { return }
        inputBuffer.frameLength = frameCount

        if let channelData = inputBuffer.floatChannelData {
            if nativeFormat.isInterleaved {
                memcpy(channelData[0], dataPtr, byteSize)
            } else {
                let bytesPerChannel = byteSize / Int(nativeFormat.channelCount)
                memcpy(channelData[0], dataPtr, bytesPerChannel)
            }
        }

        // Every input frame is converted exactly once and the output keeps
        // one continuous stream across IOProcs (see StreamingResampler). All
        // the output this buffer produced goes to stdout in one write, as
        // bare float32 samples like before.
        resampler.process(inputBuffer) { samples in
            let data = Data(buffer: samples)
            FileHandle.standardOutput.write(data)
        }
    }

    enum CaptureError: LocalizedError {
        case deviceNotFound
        case formatSetupFailed
        case coreAudioError(OSStatus)

        var errorDescription: String? {
            switch self {
            case .deviceNotFound: return "Aggregate device not found"
            case .formatSetupFailed: return "Failed to setup audio format"
            case .coreAudioError(let s): return "Core Audio error: \(s)"
            }
        }
    }
}
