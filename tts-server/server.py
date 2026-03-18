import asyncio
import base64
import io
import json
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from tts_service import SPEAKERS, TTS_MODELS, download_model, tts_service

app = FastAPI(title="Jan TTS Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class TTSStreamRequest(BaseModel):
    text: str
    voice: str | None = None
    speed: float | None = None
    instruct: str | None = None
    streaming_interval: float = 1.5


class TTSGenerateRequest(BaseModel):
    text: str
    voice: str | None = None
    speed: float | None = None
    instruct: str | None = None


class LoadModelRequest(BaseModel):
    model_id: str


class DownloadModelRequest(BaseModel):
    repo_id: str


class SettingsUpdateRequest(BaseModel):
    voice: str | None = None
    speed: float | None = None
    instruct: str | None = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# TTS streaming (SSE)
# ---------------------------------------------------------------------------

_EXHAUSTED = object()


def _next_or_sentinel(gen):
    """Call next(gen), returning _EXHAUSTED instead of raising StopIteration."""
    try:
        return next(gen)
    except StopIteration:
        return _EXHAUSTED


def _stream_tts_sync(text, voice, speed, instruct, streaming_interval):
    """Synchronous generator that yields SSE event strings."""
    try:
        gen = tts_service.generate_audio_stream(
            text=text,
            voice=voice,
            speed=speed,
            instruct=instruct,
            streaming_interval=streaming_interval,
        )
        for chunk in gen:
            if isinstance(chunk, dict):
                # Header dict from generate_audio_stream
                header = {"type": "audio_header", **chunk}
                yield f"data: {json.dumps(header)}\n\n"
            else:
                # Raw PCM float32 bytes
                b64 = base64.b64encode(chunk).decode("ascii")
                yield f"data: {json.dumps({'type': 'audio', 'data': b64})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"

    yield "data: [DONE]\n\n"


async def _stream_tts_async(text, voice, speed, instruct, streaming_interval):
    """Async wrapper that runs the sync TTS generator in an executor thread."""
    loop = asyncio.get_event_loop()
    gen = _stream_tts_sync(text, voice, speed, instruct, streaming_interval)

    while True:
        event = await loop.run_in_executor(None, _next_or_sentinel, gen)
        if event is _EXHAUSTED:
            break
        yield event


@app.post("/tts/stream")
async def tts_stream(req: TTSStreamRequest):
    if not tts_service.is_model_loaded():
        raise HTTPException(
            status_code=400,
            detail="No TTS model loaded. Load a model first via POST /tts/models/load",
        )

    return StreamingResponse(
        _stream_tts_async(
            text=req.text,
            voice=req.voice,
            speed=req.speed,
            instruct=req.instruct,
            streaming_interval=req.streaming_interval,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# TTS non-streaming (returns WAV)
# ---------------------------------------------------------------------------

@app.post("/tts/generate")
async def tts_generate(req: TTSGenerateRequest):
    if not tts_service.is_model_loaded():
        raise HTTPException(
            status_code=400,
            detail="No TTS model loaded. Load a model first via POST /tts/models/load",
        )

    try:
        loop = asyncio.get_event_loop()
        wav_bytes = await loop.run_in_executor(
            None,
            lambda: tts_service.generate_audio(
                text=req.text,
                voice=req.voice,
                speed=req.speed,
                instruct=req.instruct,
            ),
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {e}")


# ---------------------------------------------------------------------------
# Model management
# ---------------------------------------------------------------------------

@app.get("/tts/models")
async def list_models():
    return tts_service.get_available_models()


@app.post("/tts/models/load")
async def load_model(req: LoadModelRequest):
    try:
        result = tts_service.load_model(req.model_id)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load TTS model: {e}")


@app.post("/tts/models/unload")
async def unload_model():
    tts_service.unload_model()
    return {"status": "unloaded"}


@app.post("/tts/models/download")
async def download_model_endpoint(req: DownloadModelRequest):
    try:
        loop = asyncio.get_event_loop()
        path = await loop.run_in_executor(None, download_model, req.repo_id)
        return {"repo_id": req.repo_id, "path": str(path), "status": "downloaded"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download model: {e}")


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.get("/tts/settings")
async def get_settings():
    settings = tts_service.get_settings()
    models = tts_service.get_available_models()
    return {
        "voice": settings["voice"],
        "speed": settings["speed"],
        "instruct": settings["instruct"],
        "model_id": settings.get("model_id"),
        "available_voices": SPEAKERS,
        "available_models": models,
    }


@app.post("/tts/settings")
async def update_settings(req: SettingsUpdateRequest):
    settings = tts_service.update_settings(
        voice=req.voice,
        speed=req.speed,
        instruct=req.instruct,
    )
    models = tts_service.get_available_models()
    return {
        "voice": settings["voice"],
        "speed": settings["speed"],
        "instruct": settings["instruct"],
        "model_id": settings.get("model_id"),
        "available_voices": SPEAKERS,
        "available_models": models,
    }


# ---------------------------------------------------------------------------
# Speech-to-Text (Whisper)
# ---------------------------------------------------------------------------

def _transcribe_audio(audio_bytes: bytes, language: str | None, suffix: str = ".wav") -> str:
    """Transcribe audio bytes using mlx-whisper."""
    import mlx_whisper

    # Write audio to a temp file (whisper expects a file path)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        result = mlx_whisper.transcribe(
            tmp_path,
            path_or_hf_repo="mlx-community/whisper-small",
            language=language,
        )
        return result.get("text", "").strip()
    finally:
        import os
        os.unlink(tmp_path)


@app.post("/stt/transcribe")
async def stt_transcribe(
    audio: UploadFile = File(...),
    language: str | None = None,
):
    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")

        # Determine file suffix from the uploaded filename
        import os
        suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"

        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(
            None, _transcribe_audio, audio_bytes, language, suffix
        )
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
