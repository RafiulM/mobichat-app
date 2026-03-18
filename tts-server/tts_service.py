import gc
import json
import shutil
import tempfile
import threading
from pathlib import Path

MODELS_DIR = Path.home() / ".jan" / "tts-models"

SPEAKERS = [
    "ryan", "aiden", "serena", "vivian",
    "uncle_fu", "dylan", "eric", "ono_anna", "sohee",
]

TTS_MODELS = [
    {
        "id": "Qwen3-TTS-Pro",
        "name": "Qwen3-TTS Pro (1.7B)",
        "size": "1.7B",
        "repo_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
    },
    {
        "id": "Qwen3-TTS-Lite",
        "name": "Qwen3-TTS Lite (0.6B)",
        "size": "0.6B",
        "repo_id": "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
    },
]

SETTINGS_FILE = Path.home() / ".jan" / "tts_settings.json"

DEFAULT_SETTINGS = {
    "voice": "serena",
    "speed": 1.0,
    "instruct": "Normal tone",
    "model_id": None,
}


def get_model_path(local_id: str) -> Path | None:
    """Check ~/.jan/tts-models/ for a model directory."""
    path = MODELS_DIR / local_id
    if path.exists():
        return path
    return None


def list_local_model_ids() -> set[str]:
    """Return set of local model directory names under MODELS_DIR."""
    if not MODELS_DIR.exists():
        return set()
    return {p.name for p in MODELS_DIR.iterdir() if p.is_dir()}


def download_model(repo_id: str) -> Path:
    """Download a model from HuggingFace Hub to ~/.jan/tts-models/."""
    from huggingface_hub import snapshot_download

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    local_id = repo_id.replace("/", "--")
    local_dir = MODELS_DIR / local_id

    print(f"[TTS] Downloading {repo_id} to {local_dir}")
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(local_dir),
    )
    print(f"[TTS] Download complete: {local_dir}")
    return local_dir


class TTSService:
    """Singleton service for loading and running TTS models."""

    def __init__(self):
        self._model = None
        self._loaded_model_id: str | None = None
        self._generate_lock = threading.Lock()
        self._settings = self._load_settings()
        self._auto_load_model()

    @property
    def loaded_model_id(self) -> str | None:
        return self._loaded_model_id

    def is_model_loaded(self) -> bool:
        return self._model is not None

    def _load_settings(self) -> dict:
        if SETTINGS_FILE.exists():
            try:
                return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_FILE.read_text())}
            except Exception:
                pass
        return dict(DEFAULT_SETTINGS)

    def _auto_load_model(self):
        """Auto-load the last used TTS model on startup if available."""
        model_id = self._settings.get("model_id")
        if model_id:
            try:
                self.load_model(model_id)
                print(f"[TTS] Auto-loaded model: {model_id}")
            except Exception as e:
                print(f"[TTS] Auto-load failed for {model_id}: {e}")

    def _save_settings(self):
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(self._settings, indent=2))

    def get_settings(self) -> dict:
        return dict(self._settings)

    def update_settings(self, **kwargs) -> dict:
        for key in ("voice", "speed", "instruct"):
            if key in kwargs and kwargs[key] is not None:
                self._settings[key] = kwargs[key]
        self._save_settings()
        return dict(self._settings)

    def load_model(self, model_id: str) -> dict:
        """Load a TTS model into memory."""
        from mlx_audio.tts.utils import load_model

        # Find repo_id from catalog or treat model_id as a local model path
        repo_id = None
        for m in TTS_MODELS:
            if m["id"] == model_id:
                repo_id = m["repo_id"]
                break

        # Try to find the model on disk
        # The model might be stored as repo_id with / replaced by --
        local_id = model_id
        if repo_id:
            local_id = repo_id.replace("/", "--")

        path = get_model_path(local_id)
        if path is None:
            # Also try the model_id directly
            path = get_model_path(model_id)
        if path is None:
            raise FileNotFoundError(f"TTS model not found on disk: {model_id}")

        if self._model is not None:
            self.unload_model()

        try:
            self._model = load_model(str(path))
        except Exception as e:
            raise RuntimeError(f"Failed to load TTS model: {e}") from e

        self._loaded_model_id = model_id
        self._settings["model_id"] = model_id
        self._save_settings()

        return {"model_id": model_id, "status": "loaded"}

    def unload_model(self):
        """Unload the current TTS model and free memory."""
        self._model = None
        self._loaded_model_id = None
        gc.collect()

    def generate_audio(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
        instruct: str | None = None,
    ) -> bytes:
        """Generate TTS audio and return WAV bytes."""
        from mlx_audio.tts.generate import generate_audio

        if self._model is None:
            raise RuntimeError("No TTS model loaded")

        voice = voice or self._settings["voice"]
        speed = speed if speed is not None else self._settings["speed"]
        instruct = instruct or self._settings["instruct"]

        with self._generate_lock:
            temp_dir = tempfile.mkdtemp(prefix="jan_tts_")
            try:
                generate_audio(
                    model=self._model,
                    text=text,
                    voice=voice,
                    instruct=instruct,
                    speed=speed,
                    output_path=temp_dir,
                )

                # Read the generated WAV file
                wav_file = Path(temp_dir) / "audio_000.wav"
                if not wav_file.exists():
                    # Try to find any .wav file in the temp dir
                    wav_files = list(Path(temp_dir).glob("*.wav"))
                    if wav_files:
                        wav_file = wav_files[0]
                    else:
                        raise RuntimeError("TTS generation produced no audio output")

                wav_bytes = wav_file.read_bytes()
                return wav_bytes
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

    def generate_audio_stream(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
        instruct: str | None = None,
        streaming_interval: float = 1.5,
    ):
        """Generator: yields a dict header, then raw PCM float32 bytes per chunk."""
        import numpy as np

        if self._model is None:
            raise RuntimeError("No TTS model loaded")

        voice = voice or self._settings["voice"]
        speed = speed if speed is not None else self._settings["speed"]
        instruct = instruct or self._settings["instruct"]

        with self._generate_lock:
            yield {
                "sample_rate": self._model.sample_rate,
                "channels": 1,
                "format": "float32",
            }

            results = self._model.generate(
                text=text,
                voice=voice,
                instruct=instruct,
                speed=speed,
                stream=True,
                streaming_interval=streaming_interval,
                verbose=False,
            )
            for result in results:
                pcm_bytes = np.array(result.audio, copy=False).astype(np.float32).tobytes()
                yield pcm_bytes

    def get_available_models(self) -> list[dict]:
        """Return the TTS model catalog with download/load status."""
        local_ids = list_local_model_ids()

        result = []
        for m in TTS_MODELS:
            local_id = m["repo_id"].replace("/", "--")
            result.append({
                **m,
                "is_downloaded": local_id in local_ids,
                "is_loaded": m["id"] == self._loaded_model_id,
            })
        return result


# Singleton
tts_service = TTSService()
