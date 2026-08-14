"""
wake.py — always-on wake-word listener.
Say "jarvis" to launch jarvis-cortex. Quits once launched.
"""
import os, subprocess, sys, time
import urllib.request
import numpy as np
import sounddevice as sd

SAMPLE_RATE  = 16_000
CHUNK_FRAMES = 512
CHUNK_SECS   = 2.0
RMS_GATE     = 0.0008
PORT         = 8787
BUN          = "/opt/homebrew/bin/bun"
CORTEX_DIR   = "/Users/devinci/luxe-mstr-rebuild/luxe-cortex"
JARVIS_DIR   = "/Users/devinci/luxe-mstr-rebuild/Jarvis-cortex"
TRIGGERS     = {"jarvis", "drivers", "travis", "harvey", "davis"}

def _rms(arr: np.ndarray) -> float:
    f = arr.astype(np.float64)
    return float(np.sqrt(np.mean(f * f))) / 32768.0

def _dashboard_up() -> bool:
    try:
        urllib.request.urlopen(f"http://localhost:{PORT}/cortex", timeout=1)
        return True
    except Exception:
        return False

def _jarvis_running() -> bool:
    """True if main.py is already running — prevents re-triggering on JARVIS's own voice."""
    import subprocess
    r = subprocess.run(["pgrep", "-f", "main.py"], capture_output=True)
    return r.returncode == 0

def _ensure_dashboard():
    if _dashboard_up():
        return
    print("[wake] Starting CORTEX dashboard…")
    subprocess.Popen(
        [BUN, "run", "wrangler", "dev", "--port", str(PORT)],
        cwd=CORTEX_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(20):
        time.sleep(1)
        if _dashboard_up():
            print("[wake] Dashboard ready.")
            return

def main():
    # If JARVIS is already running, it owns the mic (single shared InputStream
    # inside cortex_session.py's barge-in monitor). Don't open a second stream
    # here — that starves JARVIS's own mic just like the bug we fixed inside
    # cortex_session.py. Idle until JARVIS exits, then start listening.
    while _jarvis_running():
        print("[wake] JARVIS already running — standing by (not opening mic)", end="\r", flush=True)
        time.sleep(3)

    print("\n[wake] Loading Whisper base…")
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="cpu", compute_type="int8")
    print("[wake] Ready — say 'Jarvis' to launch.")

    n_frames  = int(SAMPLE_RATE * CHUNK_SECS)
    buf: list = []
    triggered = False

    def callback(indata, frames, time_info, status):
        buf.append(indata.copy())

    # Stream stays open only until triggered — then we exit the with block cleanly
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                        blocksize=CHUNK_FRAMES, callback=callback):
        while not triggered:
            if _jarvis_running():
                # JARVIS was launched some other way while we were listening —
                # back off immediately rather than keep fighting for the mic.
                break
            time.sleep(CHUNK_SECS)
            if not buf:
                continue
            chunk = np.concatenate(buf)[:n_frames].flatten()
            buf.clear()

            rms = _rms(chunk)
            print(f"[wake] rms={rms:.4f}", end="\r", flush=True)

            if rms < RMS_GATE:
                continue

            float_audio = chunk.astype(np.float32) / 32768.0
            segments, _ = model.transcribe(float_audio, language="en", beam_size=1, vad_filter=False)
            text = " ".join(s.text for s in segments).lower().strip()
            if not text:
                continue

            print(f"\n[wake] heard: {text!r}")
            if any(t in text for t in TRIGGERS):
                if _jarvis_running():
                    print("\n[wake] JARVIS already running — ignoring trigger")
                else:
                    triggered = True

    # ── Stream is now CLOSED — audio device fully released ────────────────────
    if not triggered:
        # We broke out because JARVIS started running some other way — just
        # exit cleanly. The LaunchAgent (KeepAlive) restarts us immediately,
        # re-entering the standby loop above instead of launching a duplicate.
        return

    print("[wake] Trigger confirmed. Starting up…")
    time.sleep(0.3)   # brief pause so the device releases

    _ensure_dashboard()

    print("[wake] Handing off to JARVIS…")
    sys.stdout.flush()
    sys.stderr.flush()

    os.chdir(JARVIS_DIR)
    os.execv(sys.executable, [sys.executable, "-u", "main.py"])

if __name__ == "__main__":
    main()
