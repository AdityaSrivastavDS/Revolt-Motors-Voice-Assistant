import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 5173;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || 'gemini-2.5-flash-preview-native-audio-dialog';

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const app = express();

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static client files
app.use(express.static(path.join(__dirname, '../client')));

const httpServer = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// WebSocket: browser <-> this server <-> Gemini Live
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', async (ws) => {
  console.log('Browser connected to /ws');

  let session = null;

  // Queue for Gemini → browser messages
  const queue = [];
  const flush = () => {
    while (queue.length && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(queue.shift()));
    }
  };

  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        // ✅ System instruction limited to Revolt Motors
        systemInstruction: `
          You are an expert assistant that ONLY talks about Revolt Motors.
          - Always answer questions about Revolt Motors’ bikes, technology, features, charging, services, and company.
          - If the user asks about anything else, politely reply:
            "I’m here to talk only about Revolt Motors. Please ask me something related to that."
          - Keep answers short, clear, and engaging.
        `,
        outputAudioTranscription: {}
      },
      callbacks: {
        onopen: () => console.log('Live session opened'),
        onmessage: (m) => {
          try {
            if (m?.data) queue.push({ type: 'audio', data: m.data });

            const sc = m?.serverContent || {};
            if (sc.outputTranscription?.text) {
              queue.push({ type: 'output_transcript', text: sc.outputTranscription.text });
            }
            if (sc.turnComplete) queue.push({ type: 'turn_complete' });
            if (sc.interrupted) queue.push({ type: 'interrupted' });

            flush();
          } catch (err) {
            console.error('Forwarding error:', err);
          }
        },
        onerror: (e) => {
          console.error('Live session error:', e?.message || e);
          try {
            ws.send(JSON.stringify({ type: 'error', message: String(e?.message || e) }));
          } catch {}
        },
        onclose: (e) => {
          console.log('Live session closed:', e?.reason || '');
          try { ws.close(); } catch {}
        }
      }
    });
  } catch (err) {
    console.error('Failed to open Live session:', err);
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to open Live API session' }));
    } catch {}
    ws.close();
    return;
  }

  ws.on('message', async (raw) => {
    if (!session) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'text') {
      try {
        await session.sendRealtimeInput({
          text: String(msg.text || ''),
          turnComplete: true
        });
        // Echo input to browser
        ws.send(JSON.stringify({ type: 'input_transcript', text: msg.text }));
      } catch (e) {
        console.error('send text error:', e?.message || e);
      }
      return;
    }

    if (msg.type === 'audio') {
      try {
        await session.sendRealtimeInput({
          media: {
            data: msg.data,
            mimeType: 'audio/pcm;rate=16000'
          }
        });
      } catch (e) {
        console.error('sendRealtimeInput error:', e?.message || e);
      }
      return;
    }

    if (msg.type === 'audio_end') {
      try {
        await session.sendRealtimeInput({ mediaStreamEnd: true });
      } catch {}
      return;
    }
  });

  ws.on('close', () => {
    try { session?.close(); } catch {}
    console.log('Browser disconnected');
  });
});
