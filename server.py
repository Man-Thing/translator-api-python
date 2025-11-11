# server.py
import io, os, base64, tempfile, asyncio, json
from typing import List, Optional
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import speech_recognition as sr
from deep_translator import GoogleTranslator
from gtts import gTTS

# optional transliteration
try:
    from google.transliteration import transliterate_text
    HAVE_TRANSLITERATION = True
except Exception:
    HAVE_TRANSLITERATION = False

app = FastAPI(title="Translator (WAV-only server)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")
@app.get("/")
def root():
    return FileResponse(os.path.join("static", "index.html"))

recognizer = sr.Recognizer()

class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            self.active.append(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            if websocket in self.active:
                self.active.remove(websocket)

    async def broadcast(self, message: dict):
        data_text = json.dumps(message)
        async with self.lock:
            to_remove = []
            for ws in list(self.active):
                try:
                    await ws.send_text(data_text)
                except Exception:
                    to_remove.append(ws)
            for ws in to_remove:
                if ws in self.active:
                    self.active.remove(ws)

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            msg = await websocket.receive_text()  # keepalive; not used otherwise
            await websocket.send_text(json.dumps({"ack": "pong"}))
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception:
        await manager.disconnect(websocket)

def decode_b64(b64: str) -> bytes:
    try:
        return base64.b64decode(b64)
    except Exception as e:
        raise ValueError(f"Invalid base64: {e}")

def transcribe_wav_bytes(wav_bytes: bytes, lang_code: Optional[str]) -> str:
    with sr.AudioFile(io.BytesIO(wav_bytes)) as src:
        audio_data = recognizer.record(src)
    if not lang_code or lang_code == "auto":
        return recognizer.recognize_google(audio_data)
    return recognizer.recognize_google(audio_data, language=lang_code)

def synthesize_gtts_mp3_bytes(text: str, lang: str) -> bytes:
    tts = gTTS(text, lang=(lang if lang else "en"))
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
    tmp.close()
    tts.save(tmp.name)
    with open(tmp.name, "rb") as f:
        data = f.read()
    os.unlink(tmp.name)
    return data

@app.post("/translate")
async def translate_endpoint(request: Request):
    """
    Accept JSON:
    {
      "input_language": "en"|"auto",
      "target_language": "hi",
      "audio_b64": "<base64 WAV PCM16>",
      "audio_format": "wav",
      "transliterate": false
    }
    """
    body = await request.json()
    input_lang = body.get("input_language", "auto")
    target_lang = body.get("target_language", "en")
    transliterate = bool(body.get("transliterate", False))
    audio_b64 = body.get("audio_b64", "")
    audio_format = (body.get("audio_format") or "").lower()

    if not audio_b64:
        return JSONResponse({"error": "audio_b64 missing"}, status_code=400)

    # enforce WAV only for pip-only flow
    if audio_format != "wav":
        return JSONResponse({
            "error": "Server accepts WAV only (audio_format='wav').",
            "hint": "Make sure the browser client encodes and sends WAV PCM16."
        }, status_code=400)

    try:
        wav_bytes = decode_b64(audio_b64)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    loop = asyncio.get_event_loop()
    try:
        recognized_text = await loop.run_in_executor(None, transcribe_wav_bytes, wav_bytes, input_lang)
    except sr.UnknownValueError:
        recognized_text = ""
    except sr.RequestError as e:
        return JSONResponse({"error": f"STT request failed: {e}"}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": f"STT processing error: {e}"}, status_code=500)

    if recognized_text == "":
        return {"recognized_text": "", "translated_text": "", "audio_b64": "", "audio_mime": ""}

    stt_for_translation = recognized_text
    if transliterate and HAVE_TRANSLITERATION and input_lang not in ("auto", "en"):
        try:
            stt_for_translation = transliterate_text(recognized_text, lang_code=input_lang)
        except Exception:
            stt_for_translation = recognized_text

    try:
        translated_text = await loop.run_in_executor(None, lambda: GoogleTranslator(source=(input_lang if input_lang != "auto" else "auto"), target=target_lang).translate(text=stt_for_translation))
    except Exception as e:
        return JSONResponse({"error": f"Translation failed: {e}"}, status_code=502)

    try:
        mp3_bytes = await loop.run_in_executor(None, synthesize_gtts_mp3_bytes, translated_text, target_lang)
    except Exception as e:
        return JSONResponse({"error": f"TTS failed: {e}"}, status_code=502)

    mp3_b64 = base64.b64encode(mp3_bytes).decode("ascii")
    message = {
        "topic": "global_topic",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "recognized_text": recognized_text,
        "translated_text": translated_text,
        "audio_b64": mp3_b64,
        "audio_mime": "audio/mpeg",
        "sender": "web"
    }
    asyncio.create_task(manager.broadcast(message))
    return {
        "recognized_text": recognized_text,
        "translated_text": translated_text,
        "audio_b64": mp3_b64,
        "audio_mime": "audio/mpeg"
    }
