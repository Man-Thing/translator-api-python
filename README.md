# 🌐 Real-Time Voice Translator (FastAPI + WebSocket + Bootstrap)

This project is a real-time speech translator that:
- Takes voice input from a web browser.
- Converts it to text using Google STT.
- Translates to a target language.
- Converts translation to speech (TTS).
- Broadcasts translation audio/text to all connected clients via WebSocket.

---

## 🚀 Requirements

- Python 3.9+ (works up to 3.14)
- Internet connection (for Google APIs)

---

## 📦 Installation Steps

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd translator-api-python

# 2. Create virtual environment
python -m venv .env
.\.env\Scripts\Activate.ps1  # on Windows
# source .env/bin/activate   # on Linux/Mac

# 3. Install dependencies
python -m pip install --upgrade pip
python -m pip install fastapi "uvicorn[standard]" speechrecognition deep-translator gTTS google-transliteration-api

# 4. Run
python -m uvicorn server:app --reload --host 0.0.0.0 --port 8000