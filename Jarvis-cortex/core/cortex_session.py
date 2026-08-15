"""
core/cortex_session.py — drop-in for HermesSession with streaming LLM + overlapped TTS
plus barge-in interruption and near-zero gap between turns.

Pipeline (all stages parallel):
  SSE stream → sentence splitter → edge-tts synth → afplay

Barge-in design:
  A permanently-open background mic thread watches for speech at all times.
  When JARVIS is speaking and user's voice exceeds BARGE_RMS for 3+ chunks:
    → afplay killed immediately
    → captured audio saved as pre-roll for next utterance
    → _record_utterance picks up mid-speech with no gap

Gap reduction:
  SILENCE_SECS = 0.6 s  (vs 1.2 s before)
  Mic buffer flushed on JARVIS-stop to eliminate echo artifacts
"""
from __future__ import annotations

import asyncio
import json
import queue
import re
import subprocess
import tempfile
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

import numpy as np
import requests
import sounddevice as sd
from google import genai
from google.genai import types as genai_types

# ── Audio constants ─────────────────────────────────────────────────────────────
SAMPLE_RATE     = 16_000
CHANNELS        = 1
CHUNK_FRAMES    = 512           # ~32 ms per chunk
SILENCE_SECS    = 0.6           # seconds of silence before end-of-utterance
RMS_GATE        = 0.012         # speech onset threshold
BARGE_RMS       = 0.022         # louder threshold — definite speech, not noise
BARGE_CONFIRM   = 3             # consecutive chunks above BARGE_RMS to confirm barge-in
PRE_ROLL_CHUNKS = 8             # ~256 ms pre-roll before speech onset
MAX_RECORD_SECS = 30

NOUS_BASE_URL = "https://inference-api.nousresearch.com/v1"
DEFAULT_MODEL = "upstage/solar-pro4:free"

# Minimum chars accumulated before cutting on punctuation — avoids "Mr." splits
_MIN_SENT = 25
_SENT_RE  = re.compile(r'(?<=[.!?])["\']?\s')
_SENTINEL = object()


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _rms(chunk: np.ndarray) -> float:
    f = chunk.astype(np.float64)
    return float(np.sqrt(np.mean(f * f))) / 32768.0


def _fix_schema(schema: dict) -> dict:
    if not isinstance(schema, dict):
        return schema
    out: dict = {}
    for k, v in schema.items():
        if k == "type" and isinstance(v, str):
            out[k] = v.lower()
        elif k == "properties" and isinstance(v, dict):
            out[k] = {pk: _fix_schema(pv) for pk, pv in v.items()}
        elif k == "items" and isinstance(v, dict):
            out[k] = _fix_schema(v)
        else:
            out[k] = v
    return out


def _to_openai_tools(declarations: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name":        d["name"],
                "description": d.get("description", ""),
                "parameters":  _fix_schema(d.get("parameters", {})),
            },
        }
        for d in declarations
    ]


def _strip_md(text: str) -> str:
    text = re.sub(r'\*+', '', text)
    text = re.sub(r'#{1,6}\s*', '', text)
    text = re.sub(r'\|+', '', text)
    text = re.sub(r'`+', '', text)
    text = re.sub(r'_{1,2}([^_\n]+)_{1,2}', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return re.sub(r'\s{2,}', ' ', text).strip()


def _sentences(token_q: "queue.Queue") -> "Iterator[str]":
    """
    Reads tokens from a queue and yields complete sentences.
    Cuts on .!? followed by whitespace, only after MIN_SENT chars.
    Yields remaining buffer when queue is exhausted (None sentinel).
    """
    buf = ""
    while True:
        token = token_q.get()
        if token is _SENTINEL:
            remainder = buf.strip()
            if remainder:
                yield remainder
            return
        buf += token
        while True:
            m = _SENT_RE.search(buf)
            if m and m.start() >= _MIN_SENT:
                sentence = buf[:m.start() + 1].strip()
                buf = buf[m.end():]
                if sentence:
                    yield sentence
            else:
                break


def _synth_to_mp3(text: str, retries: int = 3) -> bytes:
    """Synthesize one sentence to MP3 bytes via edge-tts. Retries on socket error."""
    import asyncio as _aio
    import edge_tts

    async def _go():
        comm = edge_tts.Communicate(text, "en-GB-RyanNeural")
        buf  = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    for attempt in range(retries):
        loop = _aio.new_event_loop()
        try:
            return loop.run_until_complete(_go())
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(0.3 * (attempt + 1))
            else:
                raise
        finally:
            loop.close()


def _play_mp3(audio_bytes: bytes) -> None:
    """Play MP3 bytes via afplay (macOS). Blocking."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(audio_bytes)
        tmp = f.name
    try:
        subprocess.run(["afplay", tmp], check=False, timeout=60)
    finally:
        import os
        try:
            os.unlink(tmp)
        except Exception:
            pass


_PCM_RATE = 24_000   # EdgeTTS mp3 is 24 kHz mono; decoded PCM keeps that rate


def _decode_mp3_pcm(mp3: bytes) -> "bytes | None":
    """Decode MP3 bytes → raw s16le mono 24 kHz PCM via PyAV.

    Returns None when PyAV is unavailable or the payload doesn't decode —
    the caller falls back to afplay for that sentence.
    """
    try:
        import io

        import av
        out = bytearray()
        with av.open(io.BytesIO(mp3)) as container:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=_PCM_RATE)
            for frame in container.decode(audio=0):
                for rf in resampler.resample(frame):
                    out.extend(bytes(rf.planes[0]))
            for rf in resampler.resample(None):     # flush resampler tail
                out.extend(bytes(rf.planes[0]))
        return bytes(out) if out else None
    except Exception as e:
        print(f"[CortexTTS] PCM decode failed ({e}) — falling back to afplay")
        return None


# ── Streaming TTS pipeline ───────────────────────────────────────────────────────

class _TTS:
    """
    Pipelined sentence speech: source → parallel synth → one persistent
    PCM output stream.

    Sentences synthesize up to _LOOKAHEAD ahead, _SYNTH_WORKERS at a time,
    while earlier ones play — EdgeTTS network latency hides behind playback
    instead of surfacing as dead air between sentences. Decoded PCM is
    written to a single sounddevice output stream held open for the whole
    reply, so there is no per-sentence afplay spawn / device-open gap.
    afplay remains as a per-sentence fallback when PyAV cannot decode.
    """

    _LOOKAHEAD     = 4     # synthesized sentences allowed ahead of playback
    _SYNTH_WORKERS = 3
    _WRITE_SLICE   = int(_PCM_RATE * 0.2) * 2   # 200 ms of s16 mono per write — barge-in granularity

    def __init__(self):
        self._stop        = threading.Event()
        self._play_proc:  "subprocess.Popen | None" = None
        self._out_stream  = None
        self._proc_lock   = threading.Lock()

    def run(self, sentence_iter, on_start=None, on_done=None) -> None:
        """Blocking. Consumes sentence_iter, speaks all sentences, then returns."""
        from concurrent.futures import ThreadPoolExecutor

        self._stop.clear()
        fut_q: "queue.Queue" = queue.Queue(maxsize=self._LOOKAHEAD)
        pool = ThreadPoolExecutor(
            max_workers=self._SYNTH_WORKERS, thread_name_prefix="tts-synth"
        )

        def _submit_worker():
            # Ordered hand-off: futures enter fut_q in sentence order; the
            # player waits on each in turn, so parallel synth never reorders
            # speech. All queue ops use timeouts so stop() can never deadlock
            # a full/empty queue.
            try:
                for sentence in sentence_iter:
                    if self._stop.is_set():
                        break
                    text = _strip_md(sentence)
                    if not text:
                        continue
                    fut = pool.submit(_synth_to_mp3, text)
                    while not self._stop.is_set():
                        try:
                            fut_q.put(fut, timeout=0.25)
                            break
                        except queue.Full:
                            continue
            finally:
                while True:
                    try:
                        fut_q.put(_SENTINEL, timeout=0.25)
                        break
                    except queue.Full:
                        if self._stop.is_set():
                            break   # player exits on stop without the sentinel

        def _play_worker():
            stream = None
            first  = True
            try:
                while True:
                    try:
                        item = fut_q.get(timeout=0.25)
                    except queue.Empty:
                        if self._stop.is_set():
                            break
                        continue
                    if item is _SENTINEL or self._stop.is_set():
                        break
                    try:
                        mp3 = item.result()
                    except Exception as e:
                        print(f"[CortexTTS] Synth error: {e}")
                        continue
                    if self._stop.is_set():
                        break
                    if first and on_start:
                        on_start()
                        first = False
                    pcm = _decode_mp3_pcm(mp3)
                    if pcm is None:
                        self._play_afplay(mp3)
                        continue
                    if stream is None:
                        stream = sd.RawOutputStream(
                            samplerate=_PCM_RATE, channels=1, dtype="int16",
                        )
                        stream.start()
                        with self._proc_lock:
                            self._out_stream = stream
                    for i in range(0, len(pcm), self._WRITE_SLICE):
                        if self._stop.is_set():
                            break
                        try:
                            stream.write(pcm[i:i + self._WRITE_SLICE])
                        except Exception:
                            break   # stream aborted by stop() mid-write
            finally:
                with self._proc_lock:
                    self._out_stream = None
                if stream is not None:
                    try:
                        if self._stop.is_set():
                            stream.abort()      # drop buffered tail instantly
                        else:
                            stream.stop()       # let the final words drain
                        stream.close()
                    except Exception:
                        pass
                if on_done:
                    on_done()

        synth_t = threading.Thread(target=_submit_worker, daemon=True)
        play_t  = threading.Thread(target=_play_worker,  daemon=True)
        synth_t.start()
        play_t.start()
        synth_t.join()
        play_t.join()
        pool.shutdown(wait=False, cancel_futures=True)

    def _play_afplay(self, audio_bytes: bytes) -> None:
        """Fallback player — one afplay process, tracked for barge-in kill."""
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
                f.write(audio_bytes)
                tmp = f.name
            proc = subprocess.Popen(["afplay", tmp])
            with self._proc_lock:
                self._play_proc = proc
            proc.wait()
            with self._proc_lock:
                self._play_proc = None
            import os as _os
            try:
                _os.unlink(tmp)
            except Exception:
                pass
        except Exception as e:
            print(f"[CortexTTS] Play error: {e}")

    def stop(self):
        """Kill immediately — aborts the PCM stream / afplay mid-sentence."""
        self._stop.set()
        with self._proc_lock:
            proc   = self._play_proc
            stream = self._out_stream
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        if stream is not None:
            try:
                stream.abort()
            except Exception:
                pass


# ── Always-on barge-in monitor ───────────────────────────────────────────────────

class _BargeInMonitor:
    """
    Daemon thread that watches the mic continuously.
    While JARVIS is speaking, if user speaks above BARGE_RMS for BARGE_CONFIRM
    consecutive chunks → fires interrupt_cb and saves captured audio.

    The saved audio becomes the pre-roll for the next _record_utterance call
    so the user's first syllables aren't lost.
    """

    def __init__(self):
        self._interrupt_cb    = None
        self._is_speaking_fn  = lambda: False
        self._muted_fn        = lambda: False
        self._stop            = threading.Event()
        self._thread: "threading.Thread | None" = None

        self._barge_lock  = threading.Lock()
        self._barge_audio: list[np.ndarray] = []   # captured during barge-in
        self._barged      = False                    # True if barge-in fired this turn

        # Single shared mic stream — _record_utterance reads from this queue
        # instead of opening its own InputStream (avoids two streams fighting
        # over the same mic device, which starves one of them of audio).
        self._out_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=2000)

    def start(self, is_speaking_fn, muted_fn, interrupt_cb):
        self._is_speaking_fn = is_speaking_fn
        self._muted_fn       = muted_fn
        self._interrupt_cb   = interrupt_cb
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="barge-monitor")
        self._thread.start()

    def shutdown(self):
        self._stop.set()

    def take_barge_audio(self) -> list[np.ndarray]:
        """Drain and return audio captured at the moment of barge-in."""
        with self._barge_lock:
            audio = list(self._barge_audio)
            self._barge_audio.clear()
            self._barged = False
        return audio

    def reset(self):
        """Call at start of each new listen cycle."""
        with self._barge_lock:
            self._barge_audio.clear()
            self._barged = False

    def drain_live(self) -> None:
        """Discard any backlog in the live chunk queue (echo / stale audio)."""
        while True:
            try:
                self._out_q.get_nowait()
            except queue.Empty:
                break

    def get_chunk(self, timeout: float = 0.5) -> "np.ndarray | None":
        """Pull the next mic chunk from the shared stream. None on timeout."""
        try:
            return self._out_q.get(timeout=timeout)
        except queue.Empty:
            return None

    def _run(self):
        pre_roll: list[np.ndarray] = []
        consecutive = 0

        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="int16",
                blocksize=CHUNK_FRAMES,
            ) as stream:
                while not self._stop.is_set():
                    try:
                        chunk, _ = stream.read(CHUNK_FRAMES)
                    except Exception:
                        time.sleep(0.02)
                        continue

                    arr = chunk.flatten()
                    rms = _rms(arr)

                    # Broadcast every chunk to _record_utterance — this is the
                    # ONLY InputStream open for the whole session.
                    try:
                        self._out_q.put_nowait(arr)
                    except queue.Full:
                        try:
                            self._out_q.get_nowait()
                        except queue.Empty:
                            pass
                        try:
                            self._out_q.put_nowait(arr)
                        except queue.Full:
                            pass

                    # Maintain a rolling pre-roll buffer
                    pre_roll.append(arr)
                    if len(pre_roll) > PRE_ROLL_CHUNKS + BARGE_CONFIRM + 4:
                        pre_roll.pop(0)

                    speaking = self._is_speaking_fn()
                    muted    = self._muted_fn()

                    if not speaking or muted:
                        consecutive = 0
                        continue

                    # We're in a JARVIS-speaking window — watch for barge-in
                    if rms > BARGE_RMS:
                        consecutive += 1
                    else:
                        consecutive = 0

                    with self._barge_lock:
                        already_barged = self._barged

                    if consecutive >= BARGE_CONFIRM and not already_barged:
                        with self._barge_lock:
                            self._barged      = True
                            # Keep a generous pre-roll so first syllables aren't lost
                            self._barge_audio = list(pre_roll)
                        if self._interrupt_cb:
                            self._interrupt_cb()
                        consecutive = 0

        except Exception as e:
            print(f"[BargeIn] Monitor error: {e}")


# ── Streaming LLM call ───────────────────────────────────────────────────────────

def _make_reader(resp, token_q, result, first_token_event):
    """
    Returns a reader function closed over the specific objects passed in
    (avoids Python loop-closure capture bugs).
    """
    def _reader():
        tc_accum: dict[int, dict] = {}
        try:
            for line in resp.iter_lines():
                if not line:
                    continue
                if not line.startswith(b"data: "):
                    continue
                data = line[6:]
                if data == b"[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except Exception:
                    continue

                choice = (chunk.get("choices") or [{}])[0]
                delta  = choice.get("delta", {})

                content = delta.get("content") or ""
                if content:
                    first_token_event.set()
                    if not result["has_tc"]:
                        result["text"] += content
                        token_q.put(content)

                for tc_delta in (delta.get("tool_calls") or []):
                    result["has_tc"] = True
                    first_token_event.set()
                    idx = tc_delta.get("index", 0)
                    if idx not in tc_accum:
                        tc_accum[idx] = {"id": "", "function": {"name": "", "arguments": ""}}
                    if tc_delta.get("id"):
                        tc_accum[idx]["id"] = tc_delta["id"]
                    fn = tc_delta.get("function", {})
                    if fn.get("name"):
                        tc_accum[idx]["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        tc_accum[idx]["function"]["arguments"] += fn["arguments"]

        except Exception:
            pass  # resp was closed (cancelled request) — exit cleanly
        finally:
            for idx in sorted(tc_accum):
                tc = tc_accum[idx]
                raw_args = tc["function"].get("arguments", "{}")
                try:
                    args = json.loads(raw_args)
                except Exception:
                    args = {}
                result["tool_calls"].append({
                    "id":       tc.get("id", f"call_{idx}"),
                    "function": {"name": tc["function"]["name"], "arguments": args},
                })
            token_q.put(_SENTINEL)
    return _reader


def _gemini_tool_config(tool_decls: list[dict]) -> "genai_types.Tool | None":
    """Convert our Gemini-native tool declarations (uppercase JSON-schema types,
    same format used by main.py's live-audio session) into a genai Tool."""
    if not tool_decls:
        return None
    fns = []
    for d in tool_decls:
        fns.append(genai_types.FunctionDeclaration(
            name=d["name"],
            description=d.get("description", ""),
            parameters=d.get("parameters"),
        ))
    return genai_types.Tool(function_declarations=fns)


def _stream_llm(api_key: str, model: str, messages: list, tools: list):
    """Stream from Google Gemini, with native function-calling support."""
    client = genai.Client(api_key=api_key)
    token_q = queue.Queue()
    result: dict = {"text": "", "tool_calls": [], "has_tc": False}

    def _reader():
        parts = []
        for msg in messages:
            role = msg.get("role")
            if role == "system":
                parts.append(f"[System Instructions]\n{msg['content']}")
            elif role == "user":
                parts.append(f"User: {msg['content']}")
            elif role == "assistant":
                if msg.get("content"):
                    parts.append(f"Assistant: {msg['content']}")
            elif role == "tool":
                parts.append(f"[Tool Result] {msg.get('content', '')}")
        prompt = "\n\n".join(parts)

        gemini_tool = _gemini_tool_config(tools)
        config = genai_types.GenerateContentConfig(tools=[gemini_tool]) if gemini_tool else None

        for attempt in range(3):
            try:
                tc_idx = 0
                for chunk in client.models.generate_content_stream(
                    model=model,
                    contents=prompt,
                    config=config,
                ):
                    if chunk.text:
                        token_q.put(chunk.text)
                        result["text"] += chunk.text
                    for cand in (chunk.candidates or []):
                        content = getattr(cand, "content", None)
                        if not content or not content.parts:
                            continue
                        for part in content.parts:
                            fc = getattr(part, "function_call", None)
                            if fc:
                                result["has_tc"] = True
                                result["tool_calls"].append({
                                    "id": f"call_{tc_idx}",
                                    "function": {
                                        "name": fc.name,
                                        "arguments": dict(fc.args) if fc.args else {},
                                    },
                                })
                                tc_idx += 1
                break
            except Exception as e:
                transient = "503" in str(e) or "UNAVAILABLE" in str(e) or "429" in str(e)
                if transient and attempt < 2:
                    print(f"[Cortex] Gemini transient error (attempt {attempt+1}) — retrying…")
                    time.sleep(0.6 * (attempt + 1))
                    result["text"] = ""
                    continue
                print(f"[Cortex] Gemini error: {e}")
                break
        token_q.put(_SENTINEL)

    reader_t = threading.Thread(target=_reader, daemon=True)
    reader_t.start()
    return token_q, result, reader_t


class _SafeUI:
    """
    Wraps the PyQt UI object so a crashed/deleted MainWindow (WebEngine
    renderer crash, etc.) can't take down the whole voice session — calls
    into a dead Qt C++ object just get logged and swallowed instead of
    raising RuntimeError up through the session loop.
    """

    def __init__(self, real_ui):
        object.__setattr__(self, "_real", real_ui)

    def __setattr__(self, name, value):
        setattr(self._real, name, value)

    def __getattr__(self, name):
        attr = getattr(self._real, name)
        if not callable(attr):
            return attr

        def _wrapped(*args, **kwargs):
            try:
                return attr(*args, **kwargs)
            except RuntimeError as e:
                if "has been deleted" in str(e):
                    print(f"[Cortex] UI window gone, ignoring {name}() call: {e}")
                    return None
                raise

        return _wrapped


# ── Main session class ───────────────────────────────────────────────────────────

class CortexSession:
    """
    Streaming replacement for HermesSession.
    Identical __init__ signature — swap in main.py with one import line.
    """

    def __init__(
        self,
        ui,
        api_key:           str,
        tool_declarations: list[dict],
        model:             str  = DEFAULT_MODEL,
        whisper_model:     str  = "base",
        tts_config:        dict | None = None,
    ):
        self.ui               = _SafeUI(ui)
        self._api_key         = api_key
        self._model           = model
        self._tool_decls      = tool_declarations
        self._is_speaking     = False
        self._interrupted     = False
        self._stop_event      = False
        self._messages:       list[dict] = []
        self._session_log:    list[str]  = []
        self._last_user_speech = time.monotonic()
        self._asst_name       = "JARVIS"
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stt             = None
        self._whisper_model   = whisper_model
        self._tts             = _TTS()
        self._barge           = _BargeInMonitor()

        self.ui.on_text_command = self._on_text_command_sync
        self.ui.on_interrupt    = self.interrupt

    # ── Control ─────────────────────────────────────────────────────────────────

    def interrupt(self) -> None:
        """Called by barge-in monitor or UI. Kills TTS immediately."""
        self._interrupted = True
        self._tts.stop()
        self._is_speaking = False
        self.ui.set_state("LISTENING")

    def _on_text_command_sync(self, text: str) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._handle_text(text), self._loop)

    # ── System prompt ────────────────────────────────────────────────────────────

    def _build_system_prompt(self) -> str:
        BASE_DIR    = Path(__file__).resolve().parent.parent
        PROMPT_PATH = BASE_DIR / "core" / "prompt.txt"
        CONFIG_PATH = BASE_DIR / "config" / "api_keys.json"

        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            self._asst_name = (cfg.get("assistant_name") or "JARVIS").strip()
            user_name       = (cfg.get("user_name") or "").strip()
        except Exception:
            self._asst_name = "JARVIS"
            user_name       = ""

        try:
            sys_prompt = PROMPT_PATH.read_text(encoding="utf-8")
        except Exception:
            sys_prompt = (
                "You are JARVIS. Be concise. "
                "Always use tools — never simulate results."
            )

        try:
            from memory.memory_manager import load_memory, format_memory_for_prompt
            mem_str = format_memory_for_prompt(load_memory())
        except Exception:
            mem_str = ""

        now  = datetime.now().strftime("%A, %B %d, %Y — %I:%M %p")
        addr = (
            f"Always call the user '{user_name}'."
            if user_name
            else "When speaking English → say 'sir'."
        )
        parts = [
            f"[CURRENT DATE & TIME]\nRight now it is: {now}\n",
            f"[IDENTITY]\nYour name is {self._asst_name}. "
            f"Always refer to yourself as {self._asst_name}.\n{addr}\n",
        ]
        if mem_str:
            parts.append(mem_str)
        parts.append(sys_prompt)
        return "\n".join(parts)

    def _refresh_system_message(self) -> None:
        content = self._build_system_prompt()
        if self._messages and self._messages[0]["role"] == "system":
            self._messages[0]["content"] = content
        else:
            self._messages.insert(0, {"role": "system", "content": content})

    # ── Audio capture ────────────────────────────────────────────────────────────

    def _record_utterance(self) -> "np.ndarray | None":
        """
        Wait for (or continue from) user speech, capture until SILENCE_SECS of silence.

        If barge-in fired during JARVIS speech, _barge has audio already —
        we start in "speech detected" state with that audio as pre-roll,
        so the first syllables are never lost.
        """
        SIL_GATE   = int(SILENCE_SECS * SAMPLE_RATE / CHUNK_FRAMES)
        MAX_CHUNKS = int(MAX_RECORD_SECS * SAMPLE_RATE / CHUNK_FRAMES)

        # Check for barge-in pre-roll from the monitor
        barge_pre = self._barge.take_barge_audio()
        if barge_pre:
            buf          = list(barge_pre)
            speaking     = True
            silent_chunks = 0
            self._interrupted = False
        else:
            buf           = []
            speaking      = False
            silent_chunks = 0
            pre_roll: list[np.ndarray] = []
            # Discard any backlog (echo from JARVIS's own speech / thinking time)
            # accumulated in the shared mic queue before we start listening fresh.
            self._barge.drain_live()

        while not self._stop_event:
            if self.ui.muted:
                time.sleep(0.05)
                continue
            if self._interrupted and not barge_pre:
                self._interrupted = False
                return None

            arr = self._barge.get_chunk(timeout=0.5)
            if arr is None:
                continue
            rms = _rms(arr)

            if not speaking:
                pre_roll.append(arr)
                if len(pre_roll) > PRE_ROLL_CHUNKS:
                    pre_roll.pop(0)
                if rms > RMS_GATE:
                    speaking = True
                    buf.extend(pre_roll)
                    pre_roll.clear()
                    buf.append(arr)
            else:
                buf.append(arr)
                if rms < RMS_GATE * 0.6:
                    silent_chunks += 1
                    if silent_chunks >= SIL_GATE:
                        break
                else:
                    silent_chunks = 0
                if len(buf) >= MAX_CHUNKS:
                    break

        if len(buf) < 4:   # too short — noise, not speech
            return None
        return np.concatenate(buf).astype(np.float32) / 32768.0

    # ── Streaming LLM + TTS ──────────────────────────────────────────────────────

    def _stream_turn_sync(self, tools_override: "list | None" = None) -> tuple[str, list]:
        """
        Blocking. Runs one LLM turn with streaming TTS + barge-in support.
        Returns (full_text, tool_calls).
        """
        tools = tools_override if tools_override is not None else self._tool_decls

        try:
            token_q, result, reader_t = _stream_llm(
                self._api_key, self._model, list(self._messages), tools
            )
        except Exception as e:
            print(f"[Cortex] API error: {e}")
            self.ui.write_log(f"ERR: API — {str(e)[:80]}")
            return "", []

        self._tts      = _TTS()
        self._barge.reset()

        def on_start():
            self._is_speaking = True
            self.ui.set_state("SPEAKING")

        def on_done():
            self._is_speaking = False
            if not self.ui.muted:
                self.ui.set_state("LISTENING")

        # barge-in fires interrupt() which kills afplay mid-sentence
        self._tts.run(
            _sentences(token_q),
            on_start=on_start,
            on_done=on_done,
        )

        reader_t.join()

        # If interrupted mid-speech, drain remaining tokens (don't speak them)
        if self._interrupted:
            while True:
                t = token_q.get() if not token_q.empty() else _SENTINEL
                if t is _SENTINEL:
                    break

        return result["text"].strip(), result["tool_calls"]

    async def _call_cortex(self, greeting: bool = False) -> str:
        self.ui.set_state("THINKING")
        # Greeting skips tools entirely — fewer tokens = faster first response
        tools_arg: "list | None" = [] if greeting else None

        for _round in range(10):
            content, tc_list = await asyncio.to_thread(self._stream_turn_sync, tools_arg)

            if not content and not tc_list:
                self.ui.set_state("LISTENING")
                return ""

            if not tc_list:
                # Pure text response — already spoken during streaming
                if content:
                    self._messages.append({"role": "assistant", "content": content})
                    self.ui.write_log(f"{self._asst_name}: {content}")
                    self._session_log.append(f"{self._asst_name}: {content}")
                if not self.ui.muted:
                    self.ui.set_state("LISTENING")
                return content

            # Tool call response
            if content:
                self._messages.append({"role": "assistant", "content": content})

            asst_msg: dict = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id":   tc["id"],
                        "type": "function",
                        "function": {
                            "name":      tc["function"]["name"],
                            "arguments": json.dumps(tc["function"]["arguments"]),
                        },
                    }
                    for tc in tc_list
                ],
            }
            if content:
                asst_msg["content"] = content
            self._messages.append(asst_msg)

            tool_results: list[dict] = []
            for tc in tc_list:
                name = tc["function"]["name"]
                args = tc["function"]["arguments"]
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                print(f"[Cortex] 🔧 {name}  {args}")
                self.ui.set_state("THINKING")
                try:
                    res = await self._dispatch_tool(name, args)
                except Exception as ex:
                    res = f"Error: {ex}"
                    traceback.print_exc()
                print(f"[Cortex] 📤 {name} → {str(res)[:80]}")
                tool_results.append({
                    "role":         "tool",
                    "tool_call_id": tc["id"],
                    "content":      str(res),
                })
            self._messages.extend(tool_results)

        if not self.ui.muted:
            self.ui.set_state("LISTENING")
        return ""

    # ── Text command ─────────────────────────────────────────────────────────────

    async def _handle_text(self, text: str) -> None:
        self.ui.write_log(f"You: {text}")
        self._session_log.append(f"User: {text}")
        self._messages.append({"role": "user", "content": text})
        self._refresh_system_message()
        await self._call_cortex()

    # ── Tool dispatch (mirrors HermesSession._dispatch_tool) ─────────────────────

    async def _dispatch_tool(self, name: str, args: dict) -> str:
        loop     = asyncio.get_event_loop()
        speak_fn = lambda t: _play_mp3(_synth_to_mp3(_strip_md(t)))

        from memory.memory_manager import update_memory

        if name == "save_memory":
            cat, key, val = args.get("category", "notes"), args.get("key", ""), args.get("value", "")
            if key and val:
                update_memory({cat: {key: {"value": val}}})
            return "ok"

        elif name == "open_app":
            from actions.open_app import open_app
            r = await loop.run_in_executor(None, lambda: open_app(parameters=args, response=None, player=self.ui))
            return r or f"Opened {args.get('app_name')}."

        elif name == "luxe_pipeline_LIVE_WRITES":
            from actions.luxe_pipeline import luxe_pipeline
            r = await asyncio.to_thread(luxe_pipeline, parameters=args)
            return r or "Done."

        elif name == "luxe_supabase_REAL_PIPELINE":
            from actions.luxe_supabase import luxe_supabase
            from actions.pipeline_arm import utterance_contains_arm_phrase
            # If the model queued arm_live without the phrase but the last user
            # turn contained the exact arming words, arm here so one spoken
            # "GO FOR IT" is enough.
            if args.get("action") == "arm_live" and not args.get("phrase"):
                last = ""
                for msg in reversed(self._messages):
                    if msg.get("role") == "user":
                        last = str(msg.get("content") or "")
                        break
                if utterance_contains_arm_phrase(last):
                    args = {**args, "phrase": "GO FOR IT"}
            r = await asyncio.to_thread(luxe_supabase, parameters=args)
            return r or "Done."

        elif name == "weather_report":
            from actions.weather_report import weather_action
            r = await loop.run_in_executor(None, lambda: weather_action(parameters=args, player=self.ui))
            return r or "Weather delivered."

        elif name == "browser_control":
            from actions.browser_control import browser_control
            r = await loop.run_in_executor(None, lambda: browser_control(parameters=args, player=self.ui))
            return r or "Done."

        elif name == "file_controller":
            from actions.file_controller import file_controller
            r = await loop.run_in_executor(None, lambda: file_controller(parameters=args, player=self.ui))
            return r or "Done."

        elif name == "send_message":
            from actions.send_message import send_message
            r = await loop.run_in_executor(
                None, lambda: send_message(parameters=args, response=None, player=self.ui, session_memory=None)
            )
            return r or f"Message sent to {args.get('receiver')}."

        elif name == "reminder":
            from actions.reminder import reminder
            r = await loop.run_in_executor(None, lambda: reminder(parameters=args, response=None, player=self.ui))
            return r or "Reminder set."

        elif name == "youtube_video":
            from actions.youtube_video import youtube_video
            r = await loop.run_in_executor(
                None, lambda: youtube_video(parameters=args, response=None, player=self.ui)
            )
            return r or "Done."

        elif name in ("screen_process", "close_camera"):
            return "[Vision unavailable in Cortex mode — Solar Pro 4 is text-only.]"

        elif name == "computer_settings":
            from actions.computer_settings import computer_settings
            r = await loop.run_in_executor(
                None, lambda: computer_settings(parameters=args, response=None, player=self.ui)
            )
            return r or "Done."

        elif name == "desktop_control":
            from actions.desktop import desktop_control
            r = await loop.run_in_executor(None, lambda: desktop_control(parameters=args, player=self.ui))
            return r or "Done."

        elif name == "code_helper":
            from actions.code_helper import code_helper
            r = await loop.run_in_executor(
                None, lambda: code_helper(parameters=args, player=self.ui, speak=speak_fn)
            )
            return r or "Done."

        elif name == "dev_agent":
            from actions.dev_agent import dev_agent
            r = await loop.run_in_executor(
                None, lambda: dev_agent(parameters=args, player=self.ui, speak=speak_fn)
            )
            return r or "Done."

        elif name == "web_search":
            from actions.web_search import web_search as _ws
            r = await loop.run_in_executor(None, lambda: _ws(parameters=args, player=self.ui))
            if r and not r.startswith(("No results", "Search failed")):
                _q = args.get("query") or ", ".join(args.get("items", []))
                _m = args.get("mode", "search").upper()
                self.ui.show_content(f"{_m} — {_q[:38]}", r)
            return r or "Done."

        elif name == "file_processor":
            from actions.file_processor import file_processor
            if not args.get("file_path") and getattr(self.ui, "current_file", None):
                args["file_path"] = self.ui.current_file
            r = await loop.run_in_executor(
                None, lambda: file_processor(parameters=args, player=self.ui, speak=speak_fn)
            )
            return r or "Done."

        elif name == "computer_control":
            from actions.computer_control import computer_control
            r = await loop.run_in_executor(None, lambda: computer_control(parameters=args, player=self.ui))
            return r or "Done."

        elif name == "game_updater":
            from actions.game_updater import game_updater
            r = await loop.run_in_executor(
                None, lambda: game_updater(parameters=args, player=self.ui, speak=speak_fn)
            )
            return r or "Done."

        elif name == "flight_finder":
            from actions.flight_finder import flight_finder
            r = await loop.run_in_executor(None, lambda: flight_finder(parameters=args, player=self.ui))
            return r or "Done."

        elif name == "system_status":
            from actions.system_monitor import get_system_status
            r = await loop.run_in_executor(None, get_system_status)
            return str(r)

        elif name == "manage_monitor":
            from actions.background_monitor import add_monitor, remove_monitor, list_monitors
            action = args.get("action", "").lower().strip()
            topic  = args.get("topic", "").strip()
            if action == "add" and topic:
                return await asyncio.to_thread(add_monitor, topic)
            elif action == "remove" and topic:
                return await asyncio.to_thread(remove_monitor, topic)
            elif action == "list":
                items = await asyncio.to_thread(list_monitors)
                return f"Monitored: {', '.join(items)}" if items else "No active monitors."
            return "Unknown monitor action."

        elif name == "shutdown":
            import os as _os
            self._stop_event = True
            _os._exit(0)

        return f"Unknown tool: {name}"

    # ── Session summary ──────────────────────────────────────────────────────────

    async def _save_session_summary(self) -> None:
        log = self._session_log
        if len(log) < 3:
            return
        self._session_log = []
        try:
            from memory.memory_manager import save_session_summary
            convo  = "\n".join(log[-40:])
            prompt = (
                "Summarize this conversation in 1-2 sentences in English. "
                "Focus on what the user accomplished. "
                "Output ONLY the summary:\n\n" + convo
            )
            payload = {
                "model":      self._model,
                "messages":   [
                    {"role": "system", "content": "You are a concise summarizer. Output only the summary."},
                    {"role": "user",   "content": prompt},
                ],
                "max_tokens": 120,
                "stream":     False,
            }
            headers = {
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type":  "application/json",
            }
            resp = await asyncio.to_thread(
                lambda: requests.post(
                    f"{NOUS_BASE_URL}/chat/completions",
                    json=payload, headers=headers, timeout=30,
                )
            )
            summary = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            if summary:
                await asyncio.to_thread(save_session_summary, summary, "English")
                print(f"[Cortex] Session summary saved: {summary[:60]}")
        except Exception as e:
            print(f"[Cortex] Session summary failed: {e}")

    # ── Main loop ────────────────────────────────────────────────────────────────

    async def run(self) -> None:
        self._loop = asyncio.get_event_loop()

        print("[Cortex] Loading Whisper…")
        from core.stt import WhisperSTT
        self._stt = await asyncio.to_thread(WhisperSTT, self._whisper_model)

        # Warm the pipeline snapshot cache off the voice path so the first
        # CRM question answers from a local snapshot instead of paging
        # Supabase inline.
        try:
            from actions.luxe_supabase import start_cache
            start_cache()
        except Exception:
            pass

        sys_content = await asyncio.to_thread(self._build_system_prompt)
        self._messages = [{"role": "system", "content": sys_content}]

        self.ui.set_state("LISTENING")
        self.ui.write_log("SYS: JARVIS (Cortex streaming mode) online.")
        print(f"[Cortex] Connected — model={self._model}, whisper={self._whisper_model}")

        # Start always-on barge-in monitor (single stream, runs all session)
        self._barge.start(
            is_speaking_fn = lambda: self._is_speaking,
            muted_fn       = lambda: self.ui.muted,
            interrupt_cb   = self.interrupt,
        )

        # Opening greeting — no tools needed, keeps context small for fast response
        self._messages.append({
            "role": "user",
            "content": "Introduce yourself in one sentence and confirm you're ready.",
        })
        await self._call_cortex(greeting=True)

        while not self._stop_event:
            try:
                self._interrupted = False
                self._barge.reset()

                # _record_utterance blocks until user finishes speaking.
                # If barge-in fired, it already has pre-roll audio so it returns fast.
                audio = await asyncio.to_thread(self._record_utterance)
                if audio is None or len(audio) < SAMPLE_RATE * 0.2:
                    continue

                self.ui.set_state("THINKING")
                transcript = await asyncio.to_thread(self._stt.transcribe, audio)
                transcript = transcript.strip()
                if not transcript:
                    if not self.ui.muted:
                        self.ui.set_state("LISTENING")
                    continue

                self._last_user_speech = time.monotonic()
                self.ui.write_log(f"You: {transcript}")
                self._session_log.append(f"User: {transcript}")
                # Exact arming phrase — dry-run stays on without it. Mirrors to
                # Supabase settings.pipeline_live so the VM worker sees the gate.
                try:
                    from actions.pipeline_arm import utterance_contains_arm_phrase, arm_pipeline
                    if utterance_contains_arm_phrase(transcript):
                        arm_pipeline()
                        self.ui.write_log("Pipeline ARMED (GO FOR IT)")
                        # Heartbeat so always-on watchers see arm state without secrets.
                        try:
                            hb = Path(__file__).resolve().parent.parent / "config" / "pipeline_daemon.heartbeat"
                            hb.parent.mkdir(parents=True, exist_ok=True)
                            hb.write_text(
                                json.dumps({
                                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                    "armed": True,
                                    "source": "cortex_session",
                                }) + "\n",
                                encoding="utf-8",
                            )
                        except Exception:
                            pass
                except Exception:
                    pass

                self._refresh_system_message()
                self._messages.append({"role": "user", "content": transcript})
                await self._call_cortex()

                if len(self._messages) > 42:
                    self._messages = [self._messages[0]] + self._messages[-40:]

            except asyncio.CancelledError:
                break
            except RuntimeError as e:
                # The thread executor is gone (Qt window destroyed / interpreter
                # shutting down), so every asyncio.to_thread call above re-raises
                # instantly. Retrying spins a hot loop: this previously wrote
                # 45,480 identical tracebacks and 54MB to jarvis.log, burying
                # every real error in the file. Treat it as the shutdown it is.
                if "cannot schedule new futures" in str(e):
                    print("[Cortex] Executor shut down — exiting main loop.")
                    self._stop_event = True
                    break
                print(f"[Cortex] Main loop error: {e}")
                traceback.print_exc()
                if not self.ui.muted:
                    self.ui.set_state("LISTENING")
            except Exception as e:
                print(f"[Cortex] Main loop error: {e}")
                traceback.print_exc()
                if not self.ui.muted:
                    self.ui.set_state("LISTENING")

        self._barge.shutdown()
        await self._save_session_summary()
