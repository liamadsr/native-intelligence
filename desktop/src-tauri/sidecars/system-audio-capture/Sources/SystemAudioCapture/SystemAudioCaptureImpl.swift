import Foundation
import AVFoundation
import CoreAudio
import CoreGraphics
import CATapHelperLib

/// Captures system-wide audio using Core Audio Taps API and streams
/// 16kHz mono PCM float32 to stdout for the Rust parent process to read.
@available(macOS 14.4, *)
class SystemAudioCapture {

    private var tapObjectID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private var tapDescriptionInstance: AnyObject?

    private var nativeFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    /// Persistent, sample-exact converter to the 16 kHz mono output. Used only
    /// on `processingQueue`.
    private var resampler: StreamingResampler?

    private let processingQueue = DispatchQueue(label: "com.dial8.sidecar.audio", qos: .userInteractive)

    private var isActive = false

    func start() throws {
        guard CATapHelper.isAvailable() else {
            throw CaptureError.notAvailable
        }

        try createProcessTap()
        try createAggregateDevice()
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

        // Drain processing queue
        processingQueue.sync(flags: .barrier) {}

        destroyAggregateDevice()
        destroyProcessTap()

        fputs("CAPTURE_STOPPED\n", stderr)
    }

    // MARK: - Process Tap

    private func createProcessTap() throws {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let excludedProcesses = [NSNumber(value: ownPID)]

        var uuidString: NSString?
        let tapDesc = CATapHelper.createStereoGlobalTapExcludingProcesses(
            excludedProcesses,
            tapUUID: &uuidString
        )

        guard let validTapDesc = tapDesc as? CATapDescription else {
            throw CaptureError.tapCreationFailed
        }

        self.tapDescriptionInstance = validTapDesc

        var tapID: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateProcessTap(validTapDesc, &tapID)
        guard status == noErr else {
            throw CaptureError.coreAudioError(status)
        }

        self.tapObjectID = tapID
    }

    private func destroyProcessTap() {
        if tapObjectID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapObjectID)
            tapObjectID = kAudioObjectUnknown
            tapDescriptionInstance = nil
        }
    }

    // MARK: - Aggregate Device

    private func createAggregateDevice() throws {
        guard let tapDesc = tapDescriptionInstance else {
            throw CaptureError.tapCreationFailed
        }

        // Get UUID from tap description
        var tapUUID: String?
        if let uuid = (tapDesc as AnyObject).value(forKey: "UUID") as? NSUUID {
            tapUUID = uuid.uuidString
        }

        guard let uuid = tapUUID else {
            throw CaptureError.tapCreationFailed
        }

        let tapSubDevice: [String: Any] = [
            kAudioSubTapUIDKey as String: uuid
        ]

        let aggregateDeviceDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Native Intelligence Sidecar Audio",
            kAudioAggregateDeviceUIDKey as String: "com.dial8.sidecar.systemaudio",
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [tapSubDevice]
        ]

        var deviceID: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateAggregateDevice(aggregateDeviceDict as CFDictionary, &deviceID)
        guard status == noErr else {
            throw CaptureError.coreAudioError(status)
        }

        self.aggregateDeviceID = deviceID
    }

    private func destroyAggregateDevice() {
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
    }

    // MARK: - Audio Format

    private func setupAudioFormat() throws {
        guard aggregateDeviceID != kAudioObjectUnknown else {
            throw CaptureError.deviceNotReady
        }

        // Get native format from device
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
            // Try tap format
            address.mSelector = kAudioTapPropertyFormat
            status = AudioObjectGetPropertyData(
                aggregateDeviceID, &address, 0, nil, &propertySize, &asbd
            )
        }

        if status != noErr || asbd.mSampleRate <= 0 {
            // Fallback: 48kHz stereo float
            asbd.mSampleRate = 48000
            asbd.mFormatID = kAudioFormatLinearPCM
            asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
            asbd.mBitsPerChannel = 32
            asbd.mChannelsPerFrame = 2
            asbd.mFramesPerPacket = 1
            asbd.mBytesPerFrame = 8
            asbd.mBytesPerPacket = 8
        }

        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CaptureError.formatSetupFailed
        }
        self.nativeFormat = format

        // Output: 16kHz mono float32 for Whisper
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
        guard aggregateDeviceID != kAudioObjectUnknown,
              let nativeFormat = nativeFormat,
              let resampler = resampler else {
            throw CaptureError.deviceNotReady
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

            // Copy to heap for async processing
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
        case notAvailable
        case tapCreationFailed
        case deviceNotReady
        case formatSetupFailed
        case coreAudioError(OSStatus)

        var errorDescription: String? {
            switch self {
            case .notAvailable: return "Core Audio Taps not available (requires macOS 14.4+)"
            case .tapCreationFailed: return "Failed to create audio process tap"
            case .deviceNotReady: return "Aggregate audio device not ready"
            case .formatSetupFailed: return "Failed to setup audio format"
            case .coreAudioError(let s): return "Core Audio error: \(s)"
            }
        }
    }
}
