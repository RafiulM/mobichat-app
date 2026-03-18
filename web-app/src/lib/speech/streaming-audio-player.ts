/**
 * StreamingAudioPlayer — Web Audio API streaming playback.
 *
 * Port of TTSManager.swift's AVAudioEngine pattern to the browser.
 * Decodes base64 PCM chunks and schedules them for gapless playback.
 */

/**
 * Decode a base64-encoded string of 32-bit float PCM samples into a Float32Array.
 */
function base64ToFloat32Array(base64: string): Float32Array {
  const binaryString = atob(base64)
  const byteLength = binaryString.length
  const bytes = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  // Interpret raw bytes as 32-bit floats (little-endian, which is the platform default)
  return new Float32Array(bytes.buffer)
}

export class StreamingAudioPlayer {
  private audioContext: AudioContext | null = null
  private nextStartTime = 0
  private buffersScheduled = 0
  private buffersCompleted = 0
  private streamFinished = false

  /** Fires when all scheduled buffers have completed and the stream is finished. */
  onPlaybackComplete?: () => void

  /**
   * Create the AudioContext for the given sample rate and channel count.
   * Must be called before scheduling any chunks.
   */
  initialize(sampleRate: number, _channels: number): void {
    this.stop()
    this.audioContext = new AudioContext({ sampleRate })
    this.nextStartTime = 0
    this.buffersScheduled = 0
    this.buffersCompleted = 0
    this.streamFinished = false
  }

  /**
   * Decode a base64-encoded PCM chunk and schedule it for playback.
   * Chunks are played back-to-back for gapless audio.
   */
  scheduleChunk(base64PcmData: string): void {
    if (!this.audioContext) {
      return
    }

    const floatSamples = base64ToFloat32Array(base64PcmData)
    if (floatSamples.length === 0) {
      return
    }

    const ctx = this.audioContext
    const buffer = ctx.createBuffer(1, floatSamples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(floatSamples)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    // Schedule at the next available time, or now if we've fallen behind
    const startTime = Math.max(this.nextStartTime, ctx.currentTime)
    source.start(startTime)
    this.nextStartTime = startTime + buffer.duration

    this.buffersScheduled++

    source.onended = () => {
      this.buffersCompleted++
      this.checkIfPlaybackComplete()
    }
  }

  /**
   * Signal that no more chunks will be scheduled.
   * Playback-complete callback fires once remaining buffers finish.
   */
  finish(): void {
    this.streamFinished = true
    this.checkIfPlaybackComplete()
  }

  /**
   * Immediately stop playback and release resources.
   */
  stop(): void {
    if (this.audioContext) {
      this.audioContext.close().catch(() => {
        // Ignore errors when closing an already-closed context
      })
      this.audioContext = null
    }
    this.nextStartTime = 0
    this.buffersScheduled = 0
    this.buffersCompleted = 0
    this.streamFinished = false
  }

  private checkIfPlaybackComplete(): void {
    if (
      this.streamFinished &&
      this.buffersScheduled > 0 &&
      this.buffersCompleted >= this.buffersScheduled
    ) {
      this.stop()
      this.onPlaybackComplete?.()
    }
  }
}

export { base64ToFloat32Array }
