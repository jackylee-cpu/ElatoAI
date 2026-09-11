export type FastAPITranscriptWord = {
  text?: string;
  offset_ms?: number;
  duration_ms?: number;
};

export type FastAPIControlMessage = {
  type?: string;
  msg?: string;
  item_id?: string;
  text?: string;
  final?: boolean;
  delta?: boolean;
  latency_ms?: number;
  elapsed_ms?: number;
  offset_ms?: number;
  duration_ms?: number;
  words?: FastAPITranscriptWord[];
  [key: string]: unknown;
};

export type FastAPIVoiceHandlers = {
  onOpen: () => void;
  onClose: () => void;
  onError: (error: Event) => void;
  onControlMessage: (message: FastAPIControlMessage) => void;
};

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const SCRIPT_PROCESSOR_BUFFER = 1024;

// How much decoded audio the playback worklet's ring starts with, and how far
// it will grow. The server sends at twice real time (pipecat's websocket
// output transport sleeps for half a chunk's duration per chunk), so the
// client legitimately runs several seconds ahead of the speakers on a long
// answer -- the ring is not a jitter buffer, it is the whole unplayed reply.
// It grows rather than dropping, because dropping here is a hole in the middle
// of a sentence.
const PLAYBACK_RING_SECONDS = 12;
const PLAYBACK_RING_MAX_SECONDS = 90;

// How often the worklet reports its fill level back to the main thread. 4
// render quanta is 128*4/24000 = ~21ms, which is far finer than the only
// consumer needs (queuedPlaybackMs() feeds a mic-reopen delay that pads by
// 300ms anyway) and costs one postMessage per 21ms of audio.
const PLAYBACK_REPORT_QUANTA = 4;

const CAPTURE_WORKLET = `
class SttCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && input.length) {
      const ratio = sampleRate / ${INPUT_SAMPLE_RATE};
      const outLen = Math.max(1, Math.round(input.length / ratio));
      const pcm = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIndex = Math.min(input.length - 1, Math.round(i * ratio));
        const s = Math.max(-1, Math.min(1, input[srcIndex]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("stt-capture-processor", SttCaptureProcessor);
`;

// TTS playback, on the audio thread.
//
// This used to be a ScriptProcessorNode, whose onaudioprocess runs on the MAIN
// thread: any main-thread task longer than one buffer (1024 frames at 24kHz is
// 42.7ms) made it miss its deadline and the speakers got a hole. The main
// thread is busiest precisely while the bot is talking -- App.tsx reveals the
// transcript character by character -- so the audio and the animation were
// competing for the same thread. An AudioWorkletProcessor runs on the audio
// rendering thread instead, at a 128-frame quantum (5.3ms here), and cannot be
// starved by React.
//
// Int16 goes in and the conversion to float happens here, on write, so nothing
// is allocated per packet on the main thread and process() only reads.
const PLAYBACK_WORKLET = `
class TtsPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(${PLAYBACK_RING_SECONDS} * sampleRate);
    this._max = ${PLAYBACK_RING_MAX_SECONDS} * sampleRate;
    this._read = 0;
    this._write = 0;
    this._queued = 0;
    // Total samples ever accepted. The main thread knows how many it has sent
    // and subtracts this, so the fill level it reports is never stale by more
    // than what is in flight.
    this._written = 0;
    // Bumped by the main thread on clearPlayback(). A report already in flight
    // when a barge-in lands describes the answer we just abandoned, so it
    // carries its epoch and the main thread drops it if it is old.
    this._epoch = 0;
    this._sinceReport = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "audio") {
        this._push(new Int16Array(message.samples));
      } else if (message.type === "clear") {
        this._epoch = message.epoch;
        this._read = 0;
        this._write = 0;
        this._queued = 0;
        this._report();
      }
    };
  }

  _push(samples) {
    const count = samples.length;
    if (this._queued + count > this._ring.length && !this._grow(this._queued + count)) {
      return;
    }
    const ring = this._ring;
    const capacity = ring.length;
    let write = this._write;
    for (let i = 0; i < count; i++) {
      ring[write] = samples[i] / 32768;
      write = write + 1 === capacity ? 0 : write + 1;
    }
    this._write = write;
    this._queued += count;
    this._written += count;
  }

  /** Double the ring until \`needed\` fits, unwrapping it in the process. */
  _grow(needed) {
    const capacity = this._ring.length;
    let size = capacity;
    while (size < needed) size *= 2;
    if (size > this._max) {
      // 90 seconds of unplayed audio is not a buffering problem, it is a bug
      // somewhere upstream. Drop rather than grow without bound.
      return false;
    }
    const grown = new Float32Array(size);
    for (let i = 0; i < this._queued; i++) {
      grown[i] = this._ring[(this._read + i) % capacity];
    }
    this._ring = grown;
    this._read = 0;
    this._write = this._queued;
    return true;
  }

  _report() {
    this._sinceReport = 0;
    this.port.postMessage({
      queued: this._queued,
      written: this._written,
      epoch: this._epoch,
    });
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    const take = Math.min(out.length, this._queued);
    const ring = this._ring;
    const capacity = ring.length;
    let read = this._read;
    for (let i = 0; i < take; i++) {
      out[i] = ring[read];
      read = read + 1 === capacity ? 0 : read + 1;
    }
    this._read = read;
    this._queued -= take;
    // Underrun, or simply nothing to say: silence rather than whatever the
    // buffer happened to hold.
    for (let i = take; i < out.length; i++) out[i] = 0;

    if (++this._sinceReport >= ${PLAYBACK_REPORT_QUANTA}) this._report();
    return true;
  }
}
registerProcessor("tts-playback-processor", TtsPlaybackProcessor);
`;

function downsampleBuffer(
  buffer: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (outputRate === inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function int16ToFloat32(int16Array: Int16Array): Float32Array {
  const out = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = int16Array[i] / 32768;
  }
  return out;
}

export class FastAPIVoiceSession {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private outputNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  // The same node as `outputNode` when playback is running on a worklet, kept
  // separately so the port is reachable without narrowing. Deliberately not an
  // `instanceof AudioWorkletNode` check at each call site: on a browser old
  // enough to need the fallback that identifier is not defined at all, and the
  // check would throw rather than fall back.
  private playbackNode: AudioWorkletNode | null = null;
  // Only the ScriptProcessor fallback path uses this. With the worklet the
  // unplayed audio lives in the worklet's own ring, off this thread.
  private outputQueue: Float32Array[] = [];
  // One addModule() registers both processors, so capture and playback either
  // both get a worklet or both fall back together.
  private workletsReady = false;
  // Mirror of the worklet's fill level. `pushedSamples` is what this thread
  // has handed over; the rest is the worklet's last report. Queued audio is
  // then reportedQueued + (pushedSamples - reportedWritten), which counts what
  // is still in flight without ever double-counting it.
  private pushedSamples = 0;
  private reportedQueued = 0;
  private reportedWritten = 0;
  private playbackEpoch = 0;
  private handlers: FastAPIVoiceHandlers;
  // The mic starts closed and only the caller opens it. Streaming from the
  // moment the socket comes up is what let the greeting interrupt itself: the
  // server's VAD hears the room (or the answer leaking back through the
  // speakers) and closes a user turn nobody took.
  private micOpen = false;
  private levelSum = 0;
  private levelCount = 0;
  private levelPeak = 0;

  constructor(handlers: FastAPIVoiceHandlers) {
    this.handlers = handlers;
  }

  async connect(url: string) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioCtx({
      sampleRate: OUTPUT_SAMPLE_RATE,
      latencyHint: "interactive",
    });
    await this.audioContext.resume();
    await this.loadWorklets(this.audioContext);
    this.setupPlayback(this.audioContext);

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.captureNode = await this.createCaptureNode(this.audioContext);
    this.sourceNode.connect(this.captureNode);
    this.captureNode.connect(this.audioContext.destination);

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.handlers.onOpen();
    this.ws.onclose = () => this.handlers.onClose();
    this.ws.onerror = (error) => this.handlers.onError(error);
    this.ws.onmessage = (event) => this.handleMessage(event);
  }

  sendJson(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** Start streaming the mic, and reset the level meter for this press. */
  openMic() {
    this.levelSum = 0;
    this.levelCount = 0;
    this.levelPeak = 0;
    this.micOpen = true;
  }

  closeMic() {
    this.micOpen = false;
  }

  get isMicOpen() {
    return this.micOpen;
  }

  /**
   * Mean and peak |sample| (0-32767) since the last openMic(). Mean rather
   * than peak alone: one keyboard click or a knock on the desk lifts the peak
   * without there being any speech to transcribe.
   */
  micLevel() {
    return {
      average: this.levelCount === 0 ? 0 : this.levelSum / this.levelCount,
      peak: this.levelPeak,
    };
  }

  /** Barge-in: the server maps this to an InterruptionFrame. */
  sendInterrupt() {
    this.sendJson({ type: "instruction", msg: "INTERRUPT" });
  }

  /**
   * Close the user turn now. The server maps this to a
   * UserStoppedSpeakingFrame (bot.py RealtimeInputControlProcessor), which is
   * what the VAD would otherwise have to infer from a tail of silence.
   */
  sendEndOfSpeech() {
    this.sendJson({ type: "instruction", msg: "end_of_speech" });
  }

  /** Drop TTS audio already queued locally, so a barge-in goes quiet at once. */
  clearPlayback() {
    this.outputQueue = [];
    if (!this.playbackNode) return;
    // Take the local mirror to empty here rather than waiting for the
    // worklet's acknowledgement: a barge-in asks "is it quiet yet" straight
    // away, and the honest answer is yes.
    this.playbackEpoch += 1;
    this.reportedQueued = 0;
    this.reportedWritten = this.pushedSamples;
    this.playbackNode.port.postMessage({ type: "clear", epoch: this.playbackEpoch });
  }

  /**
   * How much decoded audio is still waiting to be played, in ms. The server
   * declares the turn over when TTS stops, which is a few hundred ms before
   * the last packet actually leaves the speakers.
   */
  queuedPlaybackMs() {
    const samples = this.playbackNode
      ? this.reportedQueued + (this.pushedSamples - this.reportedWritten)
      : this.outputQueue.reduce((total, chunk) => total + chunk.length, 0);
    return (samples / OUTPUT_SAMPLE_RATE) * 1000;
  }

  disconnect() {
    this.micOpen = false;
    this.ws?.close();
    this.captureNode?.disconnect();
    this.sourceNode?.disconnect();
    this.outputNode?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    void this.audioContext?.close();
    this.ws = null;
    this.captureNode = null;
    this.sourceNode = null;
    this.outputNode = null;
    this.playbackNode = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.outputQueue = [];
    this.workletsReady = false;
    this.pushedSamples = 0;
    this.reportedQueued = 0;
    this.reportedWritten = 0;
  }

  private sendPcm(buffer: ArrayBuffer) {
    // The capture graph runs for the whole session; whether its samples reach
    // the server is decided here, by whoever owns the mic.
    if (!this.micOpen) return;
    this.accumulateLevel(buffer);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  private accumulateLevel(buffer: ArrayBuffer) {
    const samples = new Int16Array(buffer);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const magnitude = Math.abs(samples[i]);
      sum += magnitude;
      if (magnitude > peak) peak = magnitude;
    }
    this.levelSum += sum;
    this.levelCount += samples.length;
    if (peak > this.levelPeak) this.levelPeak = peak;
  }

  /**
   * Register both processors from one module, and record whether it worked.
   *
   * One addModule() for the pair rather than one each: they are the same file
   * and the same failure. It also means capture and playback can never end up
   * split across a worklet and a ScriptProcessor, which would be the one
   * combination nobody tests.
   */
  private async loadWorklets(ctx: AudioContext) {
    try {
      const blob = new Blob([CAPTURE_WORKLET, PLAYBACK_WORKLET], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.workletsReady = true;
    } catch (error) {
      // Not fatal: both paths below fall back to a ScriptProcessorNode, which
      // is what this whole session used to run on. Worth a line in the console
      // though, because the fallback is the one that glitches under load.
      console.warn("Audio worklets unavailable, falling back to ScriptProcessor", error);
      this.workletsReady = false;
    }
  }

  private async createCaptureNode(ctx: AudioContext) {
    if (this.workletsReady) {
      const node = new AudioWorkletNode(ctx, "stt-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      node.port.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.sendPcm(event.data);
        }
      };
      return node;
    }

    const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    node.onaudioprocess = (event) => {
      if (!this.audioContext) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(
        input,
        this.audioContext.sampleRate,
        INPUT_SAMPLE_RATE,
      );
      this.sendPcm(floatTo16BitPCM(downsampled));
    };
    return node;
  }

  private setupPlayback(ctx: AudioContext) {
    if (this.workletsReady) {
      const node = new AudioWorkletNode(ctx, "tts-playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event) => {
        const { queued, written, epoch } = event.data as {
          queued: number;
          written: number;
          epoch: number;
        };
        // A report sent before the clear that overtook it describes audio that
        // no longer exists. Applying it would resurrect the abandoned answer
        // in queuedPlaybackMs() and hold the mic shut for its duration.
        if (epoch !== this.playbackEpoch) return;
        this.reportedQueued = queued;
        this.reportedWritten = written;
      };
      node.connect(ctx.destination);
      this.outputNode = node;
      this.playbackNode = node;
      return;
    }

    const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    node.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      out.fill(0);
      let offset = 0;
      while (offset < out.length && this.outputQueue.length > 0) {
        const chunk = this.outputQueue[0];
        const copy = Math.min(chunk.length, out.length - offset);
        out.set(chunk.subarray(0, copy), offset);
        offset += copy;
        if (copy < chunk.length) {
          this.outputQueue[0] = chunk.subarray(copy);
        } else {
          this.outputQueue.shift();
        }
      }
    };
    node.connect(ctx.destination);
    this.outputNode = node;
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data === "string") {
      try {
        this.handlers.onControlMessage(JSON.parse(event.data) as FastAPIControlMessage);
      } catch {
        this.handlers.onControlMessage({ type: "raw", msg: event.data });
      }
      return;
    }
    const buffer = event.data as ArrayBuffer;
    if (this.playbackNode) {
      // Transfer rather than copy, and let the worklet do the int16 -> float
      // conversion on its own thread: this handler runs on the main thread,
      // 25 times a second, for the whole of every answer.
      this.pushedSamples += buffer.byteLength / 2;
      this.playbackNode.port.postMessage(
        { type: "audio", samples: buffer, epoch: this.playbackEpoch },
        [buffer],
      );
      return;
    }
    this.outputQueue.push(int16ToFloat32(new Int16Array(buffer)));
  }
}
