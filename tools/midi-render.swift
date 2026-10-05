// midi-render: renders a Standard MIDI File to a 24-bit WAV with the General MIDI synthesizer that ships with
// macOS (the DLS instrument bank QuickTime and GarageBand's GM player use). Liner compiles this on first use
// with `swiftc` and keeps the binary in .cache/tools/; nothing else needs installing.
//
//   midi-render in.mid out.wav [sampleRate]
//
// Prints the length of the music in seconds. The audio engine renders offline, as fast as the CPU allows; the
// result is trimmed where the last note's tail falls below -72 dB and peak-normalised to -1 dBFS.
import AVFoundation
import AudioToolbox

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: midi-render in.mid out.wav [sampleRate]") }
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let rate = args.count > 3 ? (Double(args[3]) ?? 48000) : 48000
let maxTail = 6.0 // seconds rendered past the last event, cut back to where the sound actually ends

let engine = AVAudioEngine()
let description = AudioComponentDescription(
  componentType: kAudioUnitType_MusicDevice, componentSubType: kAudioUnitSubType_DLSSynth,
  componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
let synth = AVAudioUnitMIDIInstrument(audioComponentDescription: description)
engine.attach(synth)
guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2) else { fail("bad sample rate") }
engine.connect(synth, to: engine.mainMixerNode, format: format)
engine.connect(engine.mainMixerNode, to: engine.outputNode, format: format)

let sequencer = AVAudioSequencer(audioEngine: engine)
do { try sequencer.load(from: inURL, options: []) } catch { fail("could not read the MIDI file: \(error.localizedDescription)") }
var beats = 0.0
for track in sequencer.tracks {
  track.destinationAudioUnit = synth
  beats = max(beats, track.lengthInBeats)
}
let seconds = sequencer.seconds(forBeats: beats)
if seconds <= 0.05 { fail("the MIDI file has no notes") }

do {
  try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
  try engine.start()
} catch { fail("audio engine: \(error.localizedDescription)") }
sequencer.prepareToPlay()
do { try sequencer.start() } catch { fail("sequencer: \(error.localizedDescription)") }

guard let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount) else { fail("no buffer") }
let total = Int((seconds + maxTail) * rate)
var left = [Float](repeating: 0, count: total)
var right = [Float](repeating: 0, count: total)
var written = 0
var stalls = 0
while written < total {
  let want = AVAudioFrameCount(min(total - written, Int(buffer.frameCapacity)))
  let status: AVAudioEngineManualRenderingStatus
  do { status = try engine.renderOffline(want, to: buffer) } catch { fail("render: \(error.localizedDescription)") }
  switch status {
  case .success:
    let n = Int(buffer.frameLength)
    if let data = buffer.floatChannelData {
      left.withUnsafeMutableBufferPointer { l in right.withUnsafeMutableBufferPointer { r in
        for i in 0..<n { l[written + i] = data[0][i]; r[written + i] = data[1][i] }
      } }
    }
    written += n
    stalls = 0
  case .insufficientDataFromInputNode:
    stalls += 1
    if stalls > 100 { fail("the synthesizer stopped producing audio") }
  default:
    fail("render failed (\(status.rawValue))")
  }
}
sequencer.stop()
engine.stop()

// cut the tail where the sound has died away (below -72 dB), but never inside the music itself
let floor: Float = 0.00025
var end = Int(seconds * rate)
var i = total - 1
while i > end { if abs(left[i]) > floor || abs(right[i]) > floor { break }; i -= 1 }
end = min(total, i + Int(0.25 * rate))
var peak: Float = 0
for i in 0..<end { peak = max(peak, abs(left[i]), abs(right[i])) }
if peak < 1e-6 { fail("the MIDI file played silence") }
let gain = Float(0.891) / peak // -1 dBFS

let settings: [String: Any] = [
  AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 2,
  AVLinearPCMBitDepthKey: 24, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
]
let file: AVAudioFile
do { file = try AVAudioFile(forWriting: outURL, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false) } catch { fail("output file: \(error.localizedDescription)") }
var pos = 0
while pos < end {
  let n = min(end - pos, Int(buffer.frameCapacity))
  buffer.frameLength = AVAudioFrameCount(n)
  if let data = buffer.floatChannelData {
    for k in 0..<n { data[0][k] = left[pos + k] * gain; data[1][k] = right[pos + k] * gain }
  }
  do { try file.write(from: buffer) } catch { fail("write: \(error.localizedDescription)") }
  pos += n
}
print(String(format: "%.3f", Double(end) / rate))
