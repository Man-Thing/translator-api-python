const recStart = document.getElementById('recStart');
const recStop = document.getElementById('recStop');
const status = document.getElementById('status');
const recognized = document.getElementById('recognized');
const translated = document.getElementById('translated');
const player = document.getElementById('player');
const wsBox = document.getElementById('wsBox');
const inputLang = document.getElementById('inputLang');
const targetLang = document.getElementById('targetLang');

const language_codes = {
    "English": "en",
    "Norvegian": "no",
    "Spanish": "es",
    "Chinese (Simplified)": "zh-CN",
    "Russian": "ru",
    "Japanese": "ja",
    "Korean": "ko",
    "German": "de",
    "French": "fr",
    "Hindi": "hi",
    "Gujarati": "gu",
    "Tamil": "ta",
    "Bengali": "bn",
    "Punjabi": "pa",
    "Telugu": "te",
    "Kannada": "kn",
};
// Defaults (set to language **codes**)
const DEFAULT_INPUT = "en";
const DEFAULT_OUTPUT = "hi";

let audioContext, recorderNode, mediaStream, recordingBuffers = [], numChannels = 1, sampleRate = 16000;
let ws;

// populate dropdowns from language_codes
function populateLanguageDropdowns() {
    // build options from object entries
    const entries = Object.entries(language_codes);
    // Clear existing
    inputLang.innerHTML = "";
    targetLang.innerHTML = "";
    for (const [name, code] of entries) {
        const opt1 = document.createElement('option');
        opt1.value = code;
        opt1.textContent = name + (code ? ` (${code})` : "");
        inputLang.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = code;
        opt2.textContent = name + (code ? ` (${code})` : "");
        targetLang.appendChild(opt2);
    }
    // set defaults if present
    if ([...inputLang.options].some(o => o.value === DEFAULT_INPUT)) {
        inputLang.value = DEFAULT_INPUT;
    } else {
        inputLang.selectedIndex = 0;
    }
    if ([...targetLang.options].some(o => o.value === DEFAULT_OUTPUT)) {
        targetLang.value = DEFAULT_OUTPUT;
    } else {
        targetLang.selectedIndex = 0;
    }
}

function appendWs(msg) {
    const div = document.createElement('div');
    div.style.borderBottom = '1px solid #eee';
    div.style.padding = '6px 0';
    div.innerHTML = `<div style="font-size:12px;color:#666">${msg.timestamp || ''} • ${msg.sender || ''}</div>
                   <div><strong>Rec:</strong> ${msg.recognized_text || ''}</div>
                   <div><strong>Trans:</strong> ${msg.translated_text || ''}</div>`;
    if (msg.audio_b64) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = `data:${msg.audio_mime};base64,${msg.audio_b64}`;
        audio.style.display = 'block';
        audio.style.marginTop = '6px';
        div.appendChild(audio);
    }
    wsBox.appendChild(div, wsBox.firstChild);
}

function setupWs() {
    const loc = window.location;
    const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
    const url = protocol + "//" + loc.host + "/ws";
    ws = new WebSocket(url);
    ws.onopen = () => { appendWs({ timestamp: new Date().toISOString(), sender: 'system', translated_text: 'WS connected' }); };
    ws.onmessage = e => {
        try {
            const data = JSON.parse(e.data);
            if (data.translated_text) appendWs(data);
        } catch (err) { console.log('WS parse error', err); }
    };
    ws.onclose = () => appendWs({ timestamp: new Date().toISOString(), sender: 'system', translated_text: 'WS closed' });
}

// Recording WAV PCM16 via AudioContext
recStart.onclick = async () => {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { alert('Could not get mic: ' + e); return; }
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    sampleRate = audioContext.sampleRate;
    const source = audioContext.createMediaStreamSource(mediaStream);
    recorderNode = audioContext.createScriptProcessor(4096, numChannels, numChannels);
    recordingBuffers = [];
    recorderNode.onaudioprocess = e => {
        const ch = e.inputBuffer.getChannelData(0);
        recordingBuffers.push(new Float32Array(ch));
    };
    source.connect(recorderNode);
    recorderNode.connect(audioContext.destination);
    recStart.disabled = true; recStop.disabled = false;
    status.textContent = 'Recording...';
};

recStop.onclick = async () => {
    recStop.disabled = true; recStart.disabled = false;
    try { recorderNode.disconnect(); } catch (e) { }
    try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { }
    const merged = flattenArray(recordingBuffers);
    const wav = encodeWAV(merged, sampleRate, numChannels);
    const b64 = arrayBufferToBase64(wav);
    status.textContent = 'Uploading...';
    // send to /translate with audio_format 'wav'
    try {
        const res = await fetch('/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input_language: inputLang.value,
                target_language: targetLang.value,
                audio_b64: b64,
                audio_format: 'wav'
            })
        });
        const data = await res.json();
        recognized.value = data.recognized_text || '';
        translated.value = data.translated_text || '';
        if (data.audio_b64) {
            player.src = `data:${data.audio_mime};base64,${data.audio_b64}`;
            player.play().catch(() => { });
        }
        status.textContent = 'Ready';
    } catch (e) {
        alert('Error: ' + e);
        status.textContent = 'Error';
    }
};

function flattenArray(buffers) {
    let len = 0; for (let b of buffers) len += b.length;
    const result = new Float32Array(len);
    let offset = 0;
    for (let b of buffers) { result.set(b, offset); offset += b.length; }
    return result;
}
function floatTo16BitPCM(float32Array) {
    const l = float32Array.length; const buffer = new ArrayBuffer(l * 2); const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < l; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
}
function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) { view.setUint8(offset + i, string.charCodeAt(i)); } }
function encodeWAV(samplesFloat32, sampleRate, numChannels) {
    const bytesPerSample = 2;
    const wavBuffer = new ArrayBuffer(44 + samplesFloat32.length * bytesPerSample);
    const view = new DataView(wavBuffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samplesFloat32.length * bytesPerSample, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, 8 * bytesPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samplesFloat32.length * bytesPerSample, true);
    const pcm = floatTo16BitPCM(samplesFloat32);
    new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcm));
    return wavBuffer;
}
function arrayBufferToBase64(buffer) {
    let binary = ''; const bytes = new Uint8Array(buffer); const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// initialize dropdowns & websocket when DOM loaded
document.addEventListener('DOMContentLoaded', () => {
  populateLanguageDropdowns();
  setupWs();
});