let ws;
let mediaStream, audioCtx, workletNode, analyser, levelEl, scopeCanvas, scopeCtx;
let scheduledTime = 0; // for output playback
const OUTPUT_RATE = 24000;

const inputLog = document.getElementById("inputT");
const outputLog = document.getElementById("outputT");
const connectBtn = document.getElementById("connectBtn");
const holdBtn = document.getElementById("holdBtn");
const textBox = document.getElementById("textBox");
levelEl = document.getElementById("level");
scopeCanvas = document.getElementById("scope");
scopeCtx = scopeCanvas.getContext("2d");

function log(div, text) {
  div.textContent += (div.textContent ? "\n" : "") + text;
  div.scrollTop = div.scrollHeight;
}

function visualize(analyser) {
  const buf = new Uint8Array(512);
  function draw() {
    requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    levelEl.style.width = Math.min(100, Math.floor((peak / 128) * 100)) + "%";

    scopeCtx.clearRect(0, 0, scopeCanvas.width, scopeCanvas.height);
    scopeCtx.beginPath();
    const h = scopeCanvas.height, w = scopeCanvas.width;
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (buf.length - 1)) * w;
      const y = (buf[i] / 255) * h;
      if (i === 0) scopeCtx.moveTo(x, y);
      else scopeCtx.lineTo(x, y);
    }
    scopeCtx.strokeStyle = "#8ab4ff";
    scopeCtx.lineWidth = 2;
    scopeCtx.stroke();
  }
  draw();
}

async function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { holdBtn.disabled = false; connectBtn.disabled = true; };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "audio") {
      playPcm24kBase64(msg.data);
    } else if (msg.type === "input_transcript") {
      log(inputLog, msg.text);
    } else if (msg.type === "output_transcript") {
      log(outputLog, msg.text);
    } else if (msg.type === "interrupted") {
      scheduledTime = audioCtx ? audioCtx.currentTime : 0;
    } else if (msg.type === "error") {
      alert("Server error: " + msg.message);
    }
  };
  ws.onclose = () => { holdBtn.disabled = true; connectBtn.disabled = false; };
}

async function prepareAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await audioCtx.audioWorklet.addModule("./worklet.js");
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "downsampler");
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;

  source.connect(workletNode).connect(analyser).connect(audioCtx.destination); // analyser only
  visualize(analyser);

  // outbound audio chunks from worklet
  workletNode.port.onmessage = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const base64 = int16ToBase64(e.data);
    ws.send(JSON.stringify({ type: "audio", data: base64 }));
  };
}

function startHold() {
  workletNode?.port.postMessage({ cmd: "start" });
}

function endHold() {
  workletNode?.port.postMessage({ cmd: "stop" });
  // Tell server the stream ended
  ws?.send(JSON.stringify({ type: "audio_end" }));
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function playPcm24kBase64(b64) {
  if (!audioCtx) return;
  const int16 = base64ToInt16(b64);
  const len = int16.length;
  const audioBuffer = audioCtx.createBuffer(1, len, OUTPUT_RATE);
  const ch = audioBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = int16[i] / 32768;

  if (scheduledTime < audioCtx.currentTime) scheduledTime = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(audioCtx.destination);
  src.start(scheduledTime);
  scheduledTime += audioBuffer.duration;
}

connectBtn.addEventListener("click", async () => {
  await connect();
  await prepareAudio();
});

holdBtn.addEventListener("mousedown", startHold);
holdBtn.addEventListener("touchstart", startHold);
["mouseup", "mouseleave", "touchend", "touchcancel"].forEach(ev =>
  holdBtn.addEventListener(ev, endHold)
);

// ✅ Text box handler
textBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && textBox.value.trim()) {
    const text = textBox.value.trim();
    // log locally right away
    log(inputLog, text);
    // send to server
    ws?.send(JSON.stringify({ type: "text", text }));
    textBox.value = "";
  }
});
