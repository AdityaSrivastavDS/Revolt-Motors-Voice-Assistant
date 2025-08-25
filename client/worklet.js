class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this._acc = []; // float32 at 48k
    this.port.onmessage = (e) => {
      if (e.data?.cmd === "start") {
        this._acc = [];
        this.capturing = true;
      }
      if (e.data?.cmd === "stop") {
        this.flush();
        this.capturing = false;
      }
    };
  }

  flush() {
    if (!this._acc.length) return;
    const joined = new Float32Array(this._acc.reduce((n, arr) => n + arr.length, 0));
    let o = 0;
    for (const a of this._acc) { joined.set(a, o); o += a.length; }
    this._acc = [];

    // Downsample 48k -> 16k
    const factor = 3; // 48/16
    const fir = [0.25, 0.5, 0.25];
    const tmp = new Float32Array(joined.length);
    for (let i = 1; i < joined.length - 1; i++) {
      tmp[i] = (joined[i - 1] * fir[0]) + (joined[i] * fir[1]) + (joined[i + 1] * fir[2]);
    }

    const outLen = Math.floor(tmp.length / factor);
    const out16 = new Int16Array(outLen);
    for (let i = 0, j = 0; i < outLen; i++, j += factor) {
      let s = tmp[j];
      s = Math.max(-1, Math.min(1, s));
      out16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    this.port.postMessage(out16);
  }

  process(inputs, outputs) {
    const ch0 = inputs[0] && inputs[0][0] ? inputs[0][0] : null;
    if (!ch0) return true;

    // mute output
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);

    if (this.capturing) {
      this._acc.push(Float32Array.from(ch0));
      const samples48k = this._acc.reduce((n, arr) => n + arr.length, 0);
      if (samples48k >= 9600) { // ~0.2s at 48k
        this.flush();
      }
    }
    return true;
  }
}

registerProcessor("downsampler", Downsampler);
