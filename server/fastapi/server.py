"""Multi-transport Pipecat server for browser and ESP32 over WebSocket."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import uuid
from collections import defaultdict

import uvicorn
from fastapi import Body, FastAPI, Header, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from loguru import logger
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams

import app_settings
from bot import create_esp32_auth_message, run_bot_session
from device_registry import fetch_device_personality, fetch_user_personality
from esp32_transport import BrowserWebsocketTransport, Esp32WebsocketTransport, RawPCMFrameSerializer
from memory import session as memory_session
from models.providers import get_provider_catalog, validate_classic_provider_stack

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "7860"))
BROWSER_INPUT_SAMPLE_RATE = int(os.getenv("BROWSER_INPUT_SAMPLE_RATE", "16000"))
ESP32_INPUT_SAMPLE_RATE = int(os.getenv("ESP32_INPUT_SAMPLE_RATE", "16000"))
AUDIO_OUTPUT_SAMPLE_RATE = int(os.getenv("AUDIO_OUTPUT_SAMPLE_RATE", "24000"))
# Shared secret for /internal/*. Unset means the endpoint refuses everything --
# it must fail closed, since it can disconnect any device.
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "")

# Live ESP32 sessions, keyed by uppercased MAC. A device can briefly appear
# twice when a stale socket has not been reaped yet, hence the set.
_esp32_sessions: dict[str, set[WebSocket]] = defaultdict(set)
_sessions_lock = asyncio.Lock()

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]

BROWSER_HTML = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pipecat Browser WS</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #0e0f14; color: #f5f7fb; }
    .wrap { max-width: 920px; margin: 0 auto; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    button { padding: 10px 16px; border-radius: 10px; border: 0; cursor: pointer; }
    #connect { background: #3b82f6; color: white; }
    #disconnect { background: #374151; color: white; }
    #status { margin-left: 8px; opacity: 0.85; }
    #log { margin-top: 16px; background: #161925; border-radius: 12px; padding: 12px; height: 340px; overflow: auto; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Pipecat Browser WebSocket Test</h1>
    <div class="row">
      <button id="connect">Connect</button>
      <button id="disconnect">Disconnect</button>
      <span id="status">idle</span>
    </div>
    <div id="log"></div>
  </div>
  <script>
    const logEl = document.getElementById("log");
    const statusEl = document.getElementById("status");
    const log = (...args) => {
      const line = args.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
      logEl.textContent += line + "\\n";
      logEl.scrollTop = logEl.scrollHeight;
      console.log(...args);
    };

    let ws = null;
    let audioContext = null;
    let mediaStream = null;
    let sourceNode = null;
    let processorNode = null;
    let outputNode = null;
    let outputQueue = [];
    let connected = false;

    function setStatus(v) { statusEl.textContent = v; }

    function downsampleBuffer(buffer, inputRate, outputRate) {
      if (outputRate === inputRate) return buffer;
      const ratio = inputRate / outputRate;
      const newLength = Math.round(buffer.length / ratio);
      const result = new Float32Array(newLength);
      let offsetResult = 0;
      let offsetBuffer = 0;
      while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
        let accum = 0, count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
          accum += buffer[i];
          count++;
        }
        result[offsetResult] = accum / count;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
      }
      return result;
    }

    function floatTo16BitPCM(float32Array) {
      const buffer = new ArrayBuffer(float32Array.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < float32Array.length; i++) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return buffer;
    }

    function int16ToFloat32(int16Array) {
      const out = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) out[i] = int16Array[i] / 32768;
      return out;
    }

    function setupPlayback(ctx) {
      outputNode = ctx.createScriptProcessor(4096, 1, 1);
      outputNode.onaudioprocess = (event) => {
        const out = event.outputBuffer.getChannelData(0);
        out.fill(0);
        let offset = 0;
        while (offset < out.length && outputQueue.length > 0) {
          const chunk = outputQueue[0];
          const copy = Math.min(chunk.length, out.length - offset);
          out.set(chunk.subarray(0, copy), offset);
          offset += copy;
          if (copy < chunk.length) {
            outputQueue[0] = chunk.subarray(copy);
          } else {
            outputQueue.shift();
          }
        }
      };
      outputNode.connect(ctx.destination);
    }

    async function connect() {
      if (connected) return;
      setStatus("requesting mic");
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      setupPlayback(audioContext);
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
        ws.send(floatTo16BitPCM(downsampled));
      };
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/browser`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        connected = true;
        setStatus("connected");
        log("socket open");
      };
      ws.onclose = () => {
        connected = false;
        setStatus("closed");
        log("socket closed");
      };
      ws.onerror = (e) => {
        setStatus("error");
        log("socket error", e.type || "error");
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          log("message", event.data);
          return;
        }
        const int16 = new Int16Array(event.data);
        outputQueue.push(int16ToFloat32(int16));
      };
      setStatus("connecting");
    }

    function disconnect() {
      if (ws) ws.close();
      if (processorNode) processorNode.disconnect();
      if (sourceNode) sourceNode.disconnect();
      if (outputNode) outputNode.disconnect();
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
      if (audioContext) audioContext.close();
      ws = null;
      processorNode = null;
      sourceNode = null;
      outputNode = null;
      mediaStream = null;
      audioContext = null;
      outputQueue = [];
      connected = false;
      setStatus("idle");
    }

    document.getElementById("connect").onclick = connect;
    document.getElementById("disconnect").onclick = disconnect;
  </script>
</body>
</html>"""


def create_browser_transport(websocket: WebSocket) -> BrowserWebsocketTransport:
    return BrowserWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=BROWSER_INPUT_SAMPLE_RATE,
            audio_out_sample_rate=AUDIO_OUTPUT_SAMPLE_RATE,
            serializer=RawPCMFrameSerializer(input_sample_rate=BROWSER_INPUT_SAMPLE_RATE),
        ),
    )


def create_esp32_transport(websocket: WebSocket) -> Esp32WebsocketTransport:
    return Esp32WebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=ESP32_INPUT_SAMPLE_RATE,
            audio_out_sample_rate=AUDIO_OUTPUT_SAMPLE_RATE,
            serializer=RawPCMFrameSerializer(input_sample_rate=ESP32_INPUT_SAMPLE_RATE),
        ),
    )


def create_app() -> FastAPI:
    app = FastAPI()
    allow_all_origins = ALLOWED_ORIGINS == ["*"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS if not allow_all_origins else ["*"],
        allow_credentials=not allow_all_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/", include_in_schema=False)
    async def root_redirect():
        return RedirectResponse(url="/browser")

    @app.get("/browser", response_class=HTMLResponse)
    async def browser_page():
        return HTMLResponse(BROWSER_HTML)

    @app.get("/healthz")
    async def healthcheck():
        return {"ok": True}

    @app.get("/providers")
    async def providers_catalog():
        return get_provider_catalog()

    @app.on_event("startup")
    async def validate_provider_configuration():
        selected = validate_classic_provider_stack()
        logger.info(
            "Classic provider stack validated: stt={} llm={} tts={}",
            selected["stt"],
            selected["llm"],
            selected["tts"],
        )

    @app.websocket("/ws/browser")
    async def browser_websocket(websocket: WebSocket):
        await websocket.accept()
        logger.info("Browser websocket connected")
        transport = create_browser_transport(websocket)
        await run_bot_session(transport, "browser", False)

    @app.websocket("/ws/nextjs")
    async def nextjs_websocket(websocket: WebSocket):
        await websocket.accept()
        tts_voice = websocket.query_params.get("voice")
        title = websocket.query_params.get("title")
        character_prompt = websocket.query_params.get("character_prompt")
        voice_prompt = websocket.query_params.get("voice_prompt")
        first_message_prompt = websocket.query_params.get("first_message_prompt")
        user_id = websocket.query_params.get("user_id")
        personality_key = websocket.query_params.get("personality_key")
        logger.info(
            "NextJS websocket connected voice={} title={} user={}",
            tts_voice or "default",
            title or "default",
            user_id or "anonymous",
        )
        transport = create_browser_transport(websocket)

        # Same store the toy uses: memory is keyed by the account, not by the
        # client or the character, so what a child tells the web app is there
        # the next time they pick up the toy. `user_id` is whatever the web app
        # put on the query string; no session without one, just no memory.
        #
        # NOTE: this trusts the query string. On localhost that is the same
        # trust boundary as the rest of the dev setup, but before this is
        # exposed publicly the id has to arrive as something the browser cannot
        # forge -- a short-lived token signed by the Next.js server -- or
        # anyone who learns a user_id can read that child's memories.
        profile = await fetch_user_personality(user_id)
        memory = await memory_session.acquire(
            profile.user_id, profile.language_code
        )
        # One id per session, generated whether or not memory is running: it is
        # what ties a turn_metrics row to the conversation it was measured in.
        chat_group_id = str(uuid.uuid4())
        if memory is not None:
            memory.chat_group_id = chat_group_id
        child = {
            "name": profile.child_name,
            "age": profile.child_age,
            "persona": profile.child_persona,
            # The character arrives on the query string here, not from the
            # account row, so take the key from the same place the prompt came
            # from rather than from `profile` (which never carries one).
            "personality_key": personality_key,
        }

        try:
            await run_bot_session(
                transport,
                "browser",
                False,
                tts_voice=tts_voice,
                title=title,
                character_prompt=character_prompt,
                voice_prompt=voice_prompt,
                first_message_prompt=first_message_prompt,
                memory=memory,
                child=child,
                user_id=profile.user_id,
                chat_group_id=chat_group_id,
                language_code=profile.language_code,
            )
        finally:
            # Draining pending writes and summarising the last stretch hang off
            # this, and a browser tab closing is exactly the disconnect that
            # would otherwise lose the last turn -- the same reason the esp32
            # route releases in a finally.
            if memory is not None:
                try:
                    await memory_session.release(memory)
                except Exception as exc:  # noqa: BLE001 - teardown must not raise
                    logger.warning(
                        "Could not persist memory for {}: {}", user_id, exc
                    )

    @app.websocket("/ws/esp32")
    async def esp32_websocket(websocket: WebSocket):
        await websocket.accept()
        mac_address = websocket.headers.get("x-device-mac")
        logger.info(
            "ESP32 websocket connected: mac={} rssi={} auth={}",
            mac_address or "unknown",
            websocket.headers.get("x-wifi-rssi", "unknown"),
            "yes" if websocket.headers.get("authorization") else "no",
        )
        # The device has no query string to carry a character on, so resolve the
        # one assigned to it in Supabase. This fails open to the defaults.
        personality = await fetch_device_personality(mac_address)
        await websocket.send_text(
            json.dumps(create_esp32_auth_message(volume=personality.volume))
        )
        transport = create_esp32_transport(websocket)

        # Memory is keyed by the account the device is claimed by, not by the
        # device or the character: it is the same child either way. An
        # unclaimed device resolves to no user and simply runs without memory.
        memory = await memory_session.acquire(
            personality.user_id, personality.language_code
        )
        # Same reasoning as the browser route: the id exists for the metrics
        # even when there is no memory to attach it to.
        chat_group_id = str(uuid.uuid4())
        if memory is not None:
            memory.chat_group_id = chat_group_id
        child = {
            "name": personality.child_name,
            "age": personality.child_age,
            "persona": personality.child_persona,
            "personality_key": personality.personality_key,
        }

        session_key = (mac_address or "").strip().upper()
        if session_key:
            async with _sessions_lock:
                _esp32_sessions[session_key].add(websocket)
        try:
            await run_bot_session(
                transport,
                "esp32",
                False,
                tts_voice=personality.tts_voice,
                title=personality.title,
                character_prompt=personality.character_prompt,
                voice_prompt=personality.voice_prompt,
                memory=memory,
                child=child,
                user_id=personality.user_id,
                chat_group_id=chat_group_id,
                language_code=personality.language_code,
            )
        finally:
            # Draining pending writes and summarising the last stretch hang off
            # this. It has to be in the finally: a device that drops off wifi
            # never produces a clean disconnect event, and that last turn is
            # usually the one worth keeping.
            if memory is not None:
                try:
                    await memory_session.release(memory)
                except Exception as exc:  # noqa: BLE001 - teardown must not raise
                    logger.warning("Could not persist memory for {}: {}", mac_address, exc)
            if session_key:
                async with _sessions_lock:
                    _esp32_sessions[session_key].discard(websocket)
                    if not _esp32_sessions[session_key]:
                        del _esp32_sessions[session_key]

    @app.post("/internal/device_refresh")
    async def device_refresh(
        payload: dict = Body(...),
        x_internal_token: str | None = Header(default=None),
    ):
        """Drop a device's session so it reconnects with fresh settings.

        The character and volume are only read when a session starts, so this
        close is the mechanism that makes a change in the web app show up on the
        device -- the firmware reconnects about a second later.

        Not being connected is a success, not an error: the device picks up the
        new character whenever it next wakes.
        """
        _require_internal_token(x_internal_token)

        mac = str(payload.get("mac", "")).strip().upper()
        if not mac:
            raise HTTPException(status_code=400, detail="mac is required")

        async with _sessions_lock:
            sockets = list(_esp32_sessions.get(mac, ()))

        # Close outside the lock: each close unwinds run_bot_session, whose
        # finally block takes the same lock to deregister.
        closed = 0
        for socket in sockets:
            try:
                await socket.close(code=4001)
                closed += 1
            except Exception as exc:  # noqa: BLE001 - already-dead sockets are fine
                logger.warning("Failed to close session for {}: {}", mac, exc)

        logger.info("Device refresh for {} closed {} session(s)", mac, closed)
        return {"ok": True, "closed": closed}

    @app.post("/internal/settings_refresh")
    async def settings_refresh(x_internal_token: str | None = Header(default=None)):
        """Forget the cached app_settings row so the next session re-reads it.

        The cache would expire on its own within APP_SETTINGS_CACHE_TTL; this is
        what makes "save the model, reconnect, hear the new model" work every
        time rather than usually. Live sessions are untouched either way -- the
        model is fixed when the pipeline is built.
        """
        _require_internal_token(x_internal_token)
        app_settings.invalidate_cache()
        logger.info("App settings cache invalidated")
        return {"ok": True}

    return app


def _require_internal_token(x_internal_token: str | None) -> None:
    """Guard for /internal/*. Fails closed when no token is configured.

    Compare as bytes: compare_digest raises TypeError on a str holding
    non-ASCII, and headers arrive latin-1 decoded, so a header with any
    non-ASCII byte would 500 instead of cleanly failing auth.
    """
    if not INTERNAL_API_TOKEN:
        raise HTTPException(status_code=503, detail="internal API disabled")
    if not x_internal_token or not hmac.compare_digest(
        x_internal_token.encode("utf-8", "surrogateescape"),
        INTERNAL_API_TOKEN.encode("utf-8"),
    ):
        raise HTTPException(status_code=401, detail="bad internal token")


app = create_app()


if __name__ == "__main__":
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
