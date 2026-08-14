"""
core/hermes_session.py — JARVIS in Hermes/Nous mode.

Replaces the Gemini Live session with:
  STT  →  faster-whisper  (offline, VAD-buffered)
  LLM  →  Nous Research inference API  (OpenAI-compatible)
  TTS  →  EdgeTTS (free) or Kokoro (offline) — from core/tts.py

Config keys (config/api_keys.json):
  "hermes_mode":   true                    — enable this mode
  "nous_api_key":  "<your key>"            — from dashboard.nousresearch.com
  "nous_model":    "upstage/solar-pro4"    — optional; this is the default
  "whisper_model": "base"                  — tiny | base | small | medium
  "tts_engine":    "edgetts"               — edgetts | kokoro
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import traceback
from datetime import datetime
from pathlib import Path

import numpy as np
import requests
import sounddevice as sd

# ── Audio ──────────────────────────────────────────────────────────────────────
SAMPLE_RATE     = 16_000
CHANNELS        = 1
CHUNK_FRAMES    = 512           # ~32 ms per chunk
SILENCE_SECS    = 1.4           # end-of-speech silence gate
RMS_GATE        = 0.012         # fraction of full scale (1.0 = int16 max)
PRE_ROLL_CHUNKS = 10            # ~320 ms captured before speech onset
MAX_RECORD_SECS = 30

# ── API ────────────────────────────────────────────────────────────────────────
NOUS_BASE_URL  = "https://inference-api.nousresearch.com/v1"
DEFAULT_MODEL  = "upstage/solar-pro4"


def _rms(chunk: np.ndarray) -> float:
    f = chunk.astype(np.float64)
    return float(np.sqrt(np.mean(f * f))) / 32768.0


def _fix_schema(schema: dict) -> dict:
    """Recursively lower-case Gemini type strings for OpenAI format."""
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


def gemini_to_openai_tools(declarations: list[dict]) -> list[dict]:
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


class HermesSession:
    """
    Drives JARVIS using Whisper STT → Nous Research LLM → local TTS.
    API is designed to be a drop-in replacement for JarvisLive.run().
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
        self.ui               = ui
        self._api_key         = api_key
        self._model           = model
        self._tool_decls      = tool_declarations
        self._is_speaking     = False
        self._interrupted     = False
        self._stop_event      = False
        self._messages:      list[dict] = []
        self._session_log:   list[str]  = []
        self._last_user_speech = time.monotonic()
        self._asst_name       = "JARVIS"
        self._loop: asyncio.AbstractEventLoop | None = None

        # STT — loaded lazily in run() to avoid blocking __init__
        self._stt = None
        self._whisper_model = whisper_model

        # TTS
        from core.tts import create_tts_player
        self._tts = create_tts_player(tts_config or {"tts_engine": "edgetts"})

        self.ui.on_text_command = self._on_text_command_sync
        self.ui.on_interrupt    = self.interrupt

    # ── Public control ─────────────────────────────────────────────────────────

    def interrupt(self) -> None:
        self._interrupted = True
        self._tts.stop()
        self._is_speaking = False
        self.ui.set_state("LISTENING")
        self.ui.write_log("SYS: Interrupted — listening…")

    def _on_text_command_sync(self, text: str) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._handle_text(text), self._loop)

    # ── Prompt building ────────────────────────────────────────────────────────

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
                "You are JARVIS, Tony Stark's AI assistant. "
                "Be concise and direct. Always use tools to complete tasks — never simulate results."
            )

        try:
            from memory.memory_manager import load_memory, format_memory_for_prompt
            memory  = load_memory()
            mem_str = format_memory_for_prompt(memory)
        except Exception:
            mem_str = ""

        now  = datetime.now().strftime("%A, %B %d, %Y — %I:%M %p")
        addr = (
            f"Always call the user '{user_name}'."
            if user_name
            else "When speaking English → say 'sir'. Never mix languages."
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
        sys_content = self._build_system_prompt()
        if self._messages and self._messages[0]["role"] == "system":
            self._messages[0]["content"] = sys_content
        else:
            self._messages.insert(0, {"role": "system", "content": sys_content})

    # ── Audio capture ──────────────────────────────────────────────────────────

    def _record_utterance(self) -> np.ndarray | None:
        """
        Block until speech detected, capture until silence.
        Returns float32 mono 16 kHz suitable for Whisper, or None on stop.
        """
        pre_roll: list[np.ndarray] = []
        buf:      list[np.ndarray] = []
        silent_chunks = 0
        speaking      = False

        SIL_GATE   = int(SILENCE_SECS * SAMPLE_RATE / CHUNK_FRAMES)
        MAX_CHUNKS = int(MAX_RECORD_SECS * SAMPLE_RATE / CHUNK_FRAMES)

        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=CHUNK_FRAMES,
        ) as stream:
            while not self._stop_event:
                if self._is_speaking or self.ui.muted:
                    time.sleep(0.05)
                    continue
                if self._interrupted:
                    self._interrupted = False
                    return None

                chunk, _ = stream.read(CHUNK_FRAMES)
                arr      = chunk.flatten()
                rms      = _rms(arr)

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
                    if rms < RMS_GATE * 0.7:
                        silent_chunks += 1
                        if silent_chunks >= SIL_GATE:
                            break
                    else:
                        silent_chunks = 0
                    if len(buf) >= MAX_CHUNKS:
                        break

        if len(buf) < PRE_ROLL_CHUNKS:
            return None
        return np.concatenate(buf).astype(np.float32) / 32768.0

    # ── LLM ────────────────────────────────────────────────────────────────────

    def _call_api_sync(self, messages: list, tools: list) -> dict:
        """POST to Nous Research API. Returns {"content": str, "tool_calls": list}."""
        payload: dict = {
            "model":      self._model,
            "messages":   messages,
            "max_tokens": 800,
        }
        if tools:
            payload["tools"]       = tools
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type":  "application/json",
        }

        resp = requests.post(
            f"{NOUS_BASE_URL}/chat/completions",
            json=payload,
            headers=headers,
            timeout=60,
        )
        resp.raise_for_status()

        choice = resp.json().get("choices", [{}])[0]
        msg    = choice.get("message", {})

        tc_list: list = []
        for t in (msg.get("tool_calls") or []):
            args = t["function"].get("arguments", "{}")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            tc_list.append({
                "id":       t.get("id", ""),
                "function": {"name": t["function"]["name"], "arguments": args},
            })

        return {
            "content":    (msg.get("content") or "").strip(),
            "tool_calls": tc_list,
        }

    async def _call_hermes(self) -> str:
        """LLM → tool loop → speak. Called after user message is appended."""
        tools = gemini_to_openai_tools(self._tool_decls)
        self.ui.set_state("THINKING")

        for _round in range(10):
            try:
                result = await asyncio.to_thread(
                    self._call_api_sync, list(self._messages), tools
                )
            except Exception as e:
                print(f"[Hermes] API error: {e}")
                self.ui.write_log(f"ERR: Nous API — {str(e)[:80]}")
                self.ui.set_state("LISTENING")
                return ""

            content    = result["content"]
            tool_calls = result["tool_calls"]

            if not tool_calls:
                if content:
                    self._messages.append({"role": "assistant", "content": content})
                    self.ui.write_log(f"{self._asst_name}: {content}")
                    self._session_log.append(f"{self._asst_name}: {content}")
                    await self._speak(content)
                if not self.ui.muted:
                    self.ui.set_state("LISTENING")
                return content

            # Append assistant message with tool_calls
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
                    for tc in tool_calls
                ],
            }
            if content:
                asst_msg["content"] = content
            self._messages.append(asst_msg)

            # Execute tools
            tool_results: list[dict] = []
            for tc in tool_calls:
                name = tc["function"]["name"]
                args = tc["function"]["arguments"]
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                print(f"[Hermes] 🔧 {name}  {args}")
                self.ui.set_state("THINKING")
                try:
                    res = await self._dispatch_tool(name, args)
                except Exception as ex:
                    res = f"Error: {ex}"
                    traceback.print_exc()
                print(f"[Hermes] 📤 {name} → {str(res)[:80]}")
                tool_results.append({
                    "role":         "tool",
                    "tool_call_id": tc["id"],
                    "content":      str(res),
                })
            self._messages.extend(tool_results)

        if not self.ui.muted:
            self.ui.set_state("LISTENING")
        return ""

    # ── TTS ────────────────────────────────────────────────────────────────────

    async def _speak(self, text: str) -> None:
        self._is_speaking = True
        self.ui.set_state("SPEAKING")
        try:
            await asyncio.to_thread(self._tts.speak, text)
        finally:
            self._is_speaking = False

    # ── Tool dispatch ──────────────────────────────────────────────────────────

    async def _handle_text(self, text: str) -> None:
        self.ui.write_log(f"You: {text}")
        self._session_log.append(f"User: {text}")
        self._messages.append({"role": "user", "content": text})
        self._refresh_system_message()
        await self._call_hermes()

    async def _dispatch_tool(self, name: str, args: dict) -> str:
        loop = asyncio.get_event_loop()
        speak_fn = self._tts.speak   # blocking TTS; safe to call from executor thread

        from memory.memory_manager import update_memory, save_session_summary

        if name == "save_memory":
            cat, key, val = args.get("category", "notes"), args.get("key", ""), args.get("value", "")
            if key and val:
                update_memory({cat: {key: {"value": val}}})
            return "ok"

        elif name == "open_app":
            from actions.open_app import open_app
            r = await loop.run_in_executor(None, lambda: open_app(parameters=args, response=None, player=self.ui))
            return r or f"Opened {args.get('app_name')}."

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

        elif name == "screen_process":
            return "[Vision unavailable in Hermes mode — Solar Pro 4 is text-only.]"

        elif name == "close_camera":
            self.ui.stop_camera_stream()
            return "Camera closed."

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
            from actions.web_search import web_search as web_search_action
            r = await loop.run_in_executor(None, lambda: web_search_action(parameters=args, player=self.ui))
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

    # ── Session summary ────────────────────────────────────────────────────────

    async def _save_session_summary(self) -> None:
        log = self._session_log
        if len(log) < 3:
            return
        self._session_log = []

        try:
            from memory.memory_manager import load_memory, save_session_summary
            memory   = load_memory()
            lang_e   = memory.get("identity", {}).get("language", {})
            lang     = (lang_e.get("value", "") if isinstance(lang_e, dict) else str(lang_e)).strip() or "English"
            convo    = "\n".join(log[-40:])
            prompt   = (
                f"Summarize this conversation in 1-2 sentences in {lang}. "
                "Focus on what the user accomplished or discussed. "
                "Output ONLY the summary text, nothing else:\n\n" + convo
            )
            result = await asyncio.to_thread(
                self._call_api_sync,
                [
                    {"role": "system", "content": "You are a concise summarizer. Output only the summary."},
                    {"role": "user",   "content": prompt},
                ],
                [],
            )
            summary = result.get("content", "").strip()
            if summary:
                await asyncio.to_thread(save_session_summary, summary, lang)
                print(f"[Hermes] Session summary saved: {summary[:60]}")
        except Exception as e:
            print(f"[Hermes] Session summary failed: {e}")

    # ── Main loop ──────────────────────────────────────────────────────────────

    async def run(self) -> None:
        self._loop = asyncio.get_event_loop()

        # Load Whisper in a thread (downloads model on first run)
        from core.stt import WhisperSTT
        self._stt = await asyncio.to_thread(WhisperSTT, self._whisper_model)

        # Build initial messages
        sys_content = await asyncio.to_thread(self._build_system_prompt)
        self._messages = [{"role": "system", "content": sys_content}]

        self.ui.set_state("LISTENING")
        self.ui.write_log("SYS: JARVIS (Hermes mode) online.")
        print(f"[Hermes] Connected — model={self._model}, whisper={self._whisper_model}")

        # Opening greeting
        self._messages.append({
            "role": "user",
            "content": "Introduce yourself very briefly (1 sentence max) and confirm you're ready.",
        })
        await self._call_hermes()

        while not self._stop_event:
            try:
                # Capture utterance
                audio = await asyncio.to_thread(self._record_utterance)
                if audio is None or len(audio) < SAMPLE_RATE * 0.3:
                    continue

                # Transcribe
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

                # Refresh system time and memory before each turn
                self._refresh_system_message()
                self._messages.append({"role": "user", "content": transcript})

                await self._call_hermes()

                # Trim history: keep system [0] + last 40 messages
                if len(self._messages) > 42:
                    self._messages = [self._messages[0]] + self._messages[-40:]

            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Hermes] Main loop error: {e}")
                traceback.print_exc()
                if not self.ui.muted:
                    self.ui.set_state("LISTENING")

        await self._save_session_summary()
