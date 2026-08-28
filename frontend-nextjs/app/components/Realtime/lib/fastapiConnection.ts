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
  private outputNode: ScriptProcessorNode | null = null;
  private outputQueue: Float32Array[] = [];
  private handlers: FastAPIVoiceHandlers;

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

  disconnect() {
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
    this.mediaStream = null;
    this.audioContext = null;
    this.outputQueue = [];
  }

  private sendPcm(buffer: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  private async createCaptureNode(ctx: AudioContext) {
    try {
      const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
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
    } catch {
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
  }

  private setupPlayback(ctx: AudioContext) {
    this.outputNode = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    this.outputNode.onaudioprocess = (event) => {
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
    this.outputNode.connect(ctx.destination);
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
    const int16 = new Int16Array(event.data as ArrayBuffer);
    this.outputQueue.push(int16ToFloat32(int16));
  }
}
