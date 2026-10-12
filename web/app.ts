import { decodePcm, encodePcm, MonoResampler, PcmPlayer } from './audio';
import { TurnGate, type TurnId } from './turn-state';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}
const connect = element<HTMLButtonElement>('connect');
const talk = element<HTMLButtonElement>('talk');
const stop = element<HTMLButtonElement>('stop');
const mute = element<HTMLButtonElement>('mute');
const reset = element<HTMLButtonElement>('reset');
const handsfree = element<HTMLInputElement>('handsfree');
const barge = element<HTMLInputElement>('barge');
const transcript = element<HTMLDivElement>('transcript');
const status = element<HTMLSpanElement>('status');
const notice = element<HTMLParagraphElement>('notice');
const dot = element<HTMLSpanElement>('status-dot');
const modeNote = element<HTMLParagraphElement>('mode-note');

type ServerEvent = {
  type: string; state?: string; text?: string; message?: string;
  turnId?: TurnId; samples?: string; sampleRate?: number; name?: string;
};
let socket: WebSocket | undefined;
let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let worklet: AudioWorkletNode | undefined;
let source: MediaStreamAudioSourceNode | undefined;
let silentOutput: GainNode | undefined;
let resampler: MonoResampler | undefined;
let player: PcmPlayer | undefined;
let connected = false;
let connecting = false;
let muted = false;
let recording = false;
let ending = false;
let serverState = 'idle';
const turnGate = new TurnGate();
const assistantMessages = new Map<TurnId | 'current', HTMLElement>();
let preroll: Float32Array[] = [];
let prerollSamples = 0;
let onsetSamples = 0;
let silenceSamples = 0;
let utteranceSamples = 0;

function send(message: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function clearVad(): void {
  preroll = []; prerollSamples = 0; onsetSamples = 0; silenceSamples = 0; utteranceSamples = 0;
}
function isBusy(): boolean { return ['transcribing', 'thinking', 'speaking'].includes(serverState) || !!player?.active; }
function updateUi(): void {
  connect.disabled = connecting;
  connect.textContent = connecting ? 'Connecting…' : connected ? 'Disconnect' : 'Connect microphone';
  talk.style.display = connected ? 'block' : 'none';
  talk.disabled = !connected || muted || handsfree.checked;
  talk.classList.toggle('recording', recording);
  talk.innerHTML = recording
    ? handsfree.checked ? 'Listening… pause to send' : 'Listening… release to send'
    : handsfree.checked ? 'Hands-free enabled' : 'Hold to talk <span>SPACE</span>';
  mute.disabled = !connected;
  mute.textContent = muted ? 'Unmute mic' : 'Mute mic';
  mute.setAttribute('aria-pressed', String(muted));
  stop.disabled = !connected || (!isBusy() && !recording);
  reset.disabled = !connected;
  barge.disabled = !handsfree.checked;
  dot.classList.toggle('active', connected && !muted);
  const labels: Record<string, string> = { idle: 'Ready to listen', listening: 'Listening', transcribing: 'Transcribing', thinking: 'Thinking', speaking: 'Speaking' };
  status.textContent = connecting ? 'Requesting microphone & connecting' : !connected ? 'Ready to connect' : muted ? 'Microphone muted' : recording ? 'Listening' : player?.active ? 'Speaking' : labels[serverState] ?? serverState;
  modeNote.textContent = handsfree.checked
    ? barge.checked ? 'Hands-free is on. Speak to interrupt a reply; headphones are recommended.' : 'Hands-free is on. Wait for the reply to finish, then speak. Silence sends your turn.'
    : 'Push-to-talk gives you control. Hold Space or the talk button, then release to send.';
}
function addMessage(role: 'user' | 'assistant', text: string): HTMLElement {
  document.getElementById('empty')?.remove();
  const message = document.createElement('div');
  message.className = `message ${role}`;
  const speaker = document.createElement('span');
  speaker.className = 'speaker';
  speaker.textContent = role === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('span');
  body.textContent = text;
  message.append(speaker, body);
  transcript.append(message);
  transcript.scrollTop = transcript.scrollHeight;
  return body;
}
function cancelReply(sendInterrupt = true): void {
  turnGate.cancel();
  player?.stop();
  if (sendInterrupt) send({ type: 'interrupt' });
  serverState = 'idle';
}
function beginUtterance(): void {
  if (!connected || muted || recording || ending) return;
  cancelReply(false);
  turnGate.start();
  recording = true;
  notice.textContent = '';
  silenceSamples = 0; utteranceSamples = 0;
  send({ type: 'start' });
  updateUi();
}
function finishUtterance(): void {
  if (!recording || ending) return;
  ending = true;
  // Flush the worklet's partial block before sending the utterance boundary.
  worklet?.port.postMessage('flush');
}
function completeUtterance(): void {
  if (!ending) return;
  ending = false; recording = false;
  send({ type: 'end' });
  serverState = 'transcribing';
  clearVad(); updateUi();
}
function sendAudio(samples: Float32Array): void {
  if (!recording || socket?.readyState !== WebSocket.OPEN || !samples.length) return;
  if (socket.bufferedAmount > 1024 * 1024) {
    recording = false; ending = false; clearVad(); cancelReply();
    notice.textContent = 'Connection could not keep up with microphone audio. Please try again.';
    updateUi(); return;
  }
  // The server's 30-second limit applies to all chunks, including the flushed tail.
  const remaining = 480000 - utteranceSamples;
  const frame = samples.subarray(0, Math.max(0, remaining));
  if (frame.length) socket.send(encodePcm(frame));
  utteranceSamples += frame.length;
}
function processMicrophone(input: Float32Array): void {
  const samples = resampler?.process(input);
  if (!samples || !connected || (muted && !ending)) return;
  if (!handsfree.checked) {
    if (recording) {
      sendAudio(samples);
      if (utteranceSamples >= 480000) finishUtterance();
    }
    return;
  }
  if (ending) { sendAudio(samples); return; }
  if (!recording && !barge.checked && (isBusy() || player?.blocksHandsfree)) { clearVad(); return; }
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const speech = Math.sqrt(sum / samples.length) > 0.018;
  if (!recording) {
    preroll.push(samples); prerollSamples += samples.length;
    while (prerollSamples > 5600 && preroll.length > 1) prerollSamples -= preroll.shift()!.length;
    onsetSamples = speech ? onsetSamples + samples.length : 0;
    if (onsetSamples < 1600) return;
    beginUtterance();
    for (const frame of preroll) sendAudio(frame);
    preroll = []; prerollSamples = 0;
  } else {
    sendAudio(samples);
  }
  silenceSamples = speech ? 0 : silenceSamples + samples.length;
  if (silenceSamples >= 11200 || utteranceSamples >= 480000) finishUtterance();
}
function handleEvent(event: ServerEvent): void {
  if (event.type === 'ready') { connected = true; connecting = false; notice.textContent = ''; updateUi(); return; }
  if (!turnGate.accept(event)) return;
  switch (event.type) {
    case 'status': serverState = event.state ?? 'idle'; break;
    case 'transcript': if (event.text) addMessage('user', event.text); break;
    case 'assistant': {
      const key = event.turnId ?? 'current';
      const message = assistantMessages.get(key) ?? addMessage('assistant', '');
      assistantMessages.set(key, message);
      message.textContent += event.text ?? '';
      transcript.scrollTop = transcript.scrollHeight;
      break;
    }
    case 'tool': notice.textContent = `Using ${event.name ?? 'a local tool'}…`; break;
    case 'audio':
      if (event.samples) {
        try { player?.play(decodePcm(event.samples), event.sampleRate ?? 24000); }
        catch (error) { cancelReply(); notice.textContent = error instanceof Error ? error.message : 'Playback failed.'; }
      }
      break;
    case 'audio_end': serverState = 'idle'; notice.textContent = ''; break;
    case 'interrupted':
      player?.stop(); turnGate.cancel(); recording = false; ending = false; clearVad(); serverState = 'idle'; break;
    case 'error':
      recording = false; ending = false; clearVad(); cancelReply();
      notice.textContent = event.message ?? 'A local model error occurred.'; break;
  }
  updateUi();
}
async function disconnect(): Promise<void> {
  connected = false; connecting = false; recording = false; ending = false; muted = false;
  player?.stop();
  const oldSocket = socket; socket = undefined;
  if (oldSocket) { oldSocket.onclose = null; oldSocket.close(); }
  stream?.getTracks().forEach(track => track.stop());
  worklet?.disconnect(); source?.disconnect(); silentOutput?.disconnect();
  if (worklet) worklet.port.onmessage = null;
  const oldContext = context;
  context = undefined; player = undefined; stream = undefined; worklet = undefined;
  source = undefined; silentOutput = undefined; resampler = undefined;
  clearVad(); serverState = 'idle'; updateUi();
  turnGate.reset(); assistantMessages.clear();
  if (oldContext && oldContext.state !== 'closed') await oldContext.close();
}
connect.addEventListener('click', async () => {
  if (connected) { await disconnect(); return; }
  connecting = true; notice.textContent = ''; updateUi();
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Microphone audio requires a modern browser on localhost or HTTPS.');
    context = new AudioContext();
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await context.audioWorklet.addModule('/capture-worklet.js');
    player = new PcmPlayer(context);
    resampler = new MonoResampler(context.sampleRate);
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'microphone-capture');
    silentOutput = context.createGain(); silentOutput.gain.value = 0;
    source.connect(worklet); worklet.connect(silentOutput); silentOutput.connect(context.destination);
    worklet.port.onmessage = event => event.data === 'flushed' ? completeUtterance() : processMicrophone(event.data as Float32Array);
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    const currentSocket = socket;
    const timeout = window.setTimeout(() => {
      if (socket === currentSocket && !connected) { void disconnect(); notice.textContent = 'The local server did not become ready. Check the server terminal.'; }
    }, 15000);
    socket.onmessage = event => {
      if (socket !== currentSocket) return;
      try { handleEvent(JSON.parse(String(event.data)) as ServerEvent); }
      catch { notice.textContent = 'Received an invalid server message.'; }
      if (connected) window.clearTimeout(timeout);
    };
    socket.onerror = () => { notice.textContent = 'Could not connect to the local voice server.'; };
    socket.onclose = () => {
      window.clearTimeout(timeout);
      if (socket === currentSocket) { void disconnect(); notice.textContent = 'Disconnected. Reconnect to continue.'; }
    };
  } catch (error) {
    await disconnect();
    notice.textContent = error instanceof Error ? error.message : 'Could not start the microphone.';
  }
});
talk.addEventListener('pointerdown', event => { event.preventDefault(); talk.setPointerCapture(event.pointerId); beginUtterance(); });
talk.addEventListener('pointerup', finishUtterance);
talk.addEventListener('pointercancel', finishUtterance);
talk.addEventListener('lostpointercapture', finishUtterance);
window.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || !connected || handsfree.checked) return;
  const target = event.target as HTMLElement;
  if (target.matches('input,textarea,select,button,a,[contenteditable]') && target !== talk) return;
  event.preventDefault(); beginUtterance();
});
window.addEventListener('keyup', event => { if (event.code === 'Space' && !handsfree.checked && recording) { event.preventDefault(); finishUtterance(); } });
window.addEventListener('blur', () => { if (recording) finishUtterance(); });
stop.addEventListener('click', () => { recording = false; ending = false; clearVad(); cancelReply(); updateUi(); });
mute.addEventListener('click', () => {
  if (recording) finishUtterance();
  muted = !muted;
  stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  clearVad(); updateUi();
});
handsfree.addEventListener('change', () => { if (recording) finishUtterance(); clearVad(); updateUi(); });
barge.addEventListener('change', () => { clearVad(); updateUi(); });
reset.addEventListener('click', () => {
  recording = false; ending = false; clearVad(); cancelReply(); send({ type: 'reset' });
  assistantMessages.clear(); transcript.replaceChildren(); notice.textContent = 'Conversation cleared.'; updateUi();
});
window.addEventListener('pagehide', () => { void disconnect(); });
window.setInterval(updateUi, 150);
updateUi();
