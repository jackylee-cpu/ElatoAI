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
import device_auth
import session_content
from bot import create_esp32_auth_message, run_bot_session
from device_registry import fetch_device_personality, fetch_user_personality
from esp32_transport import (
    BrowserWebsocketTransport,
    Esp32WebsocketTransport,
    RawPCMFrameSerializer,
)
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
# Let a board nobody has claimed talk anyway, as the default character with no
# memory. For local development only, alongside the web app's
# NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=True, which hands such a board a token.
ALLOW_UNCLAIMED_DEVICES = os.getenv("ALLOW_UNCLAIMED_DEVICES", "").strip().lower() in (
    "1",
    "true",
    "yes",
)

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

    # The /browser page and its /ws/browser socket run a full session with no
    # account and no token: anyone who finds them talks on our STT, LLM and TTS
    # keys. Off unless asked for, which in practice means local development.
    browser_test = os.getenv("ENABLE_BROWSER_TEST", "").strip().lower() in ("1", "true", "yes")

    if browser_test:
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
    async def sync_modes_and_styles():
        # Deploying a change to content/*.yaml is the whole of releasing it:
        # the web app lists modes and styles from their tables, so they are
        # brought in line with the YAML here. Fails open with a warning.
        await session_content.sync_catalog()

    @app.on_event("startup")
    async def validate_provider_configuration():
        selected = validate_classic_provider_stack()
        logger.info(
            "Classic provider stack validated: stt={} llm={} tts={}",
            selected["stt"],
            selected["llm"],
            selected["tts"],
        )

    if browser_test:
        @app.websocket("/ws/browser")
        async def browser_websocket(websocket: WebSocket):
            await websocket.accept()
            logger.info("Browser websocket connected")
            transport = create_browser_transport(websocket)
            await run_bot_session(transport, "browser", False)

    @app.websocket("/ws/nextjs")
    async def nextjs_websocket(websocket: WebSocket):
        await websocket.accept()
        # Whose session this is comes from the web voice token the web app's
        # server signed for the signed-in account (actions.ts,
        # createVoiceSessionToken), never from the query string -- anyone who
        # learned a user_id used to be able to read that child's memories, and
        # any page could put its own character prompt on the URL. 4401 as on
        # the device route.
        try:
            user_id = device_auth.verify_web(websocket.query_params.get("token"))
        except device_auth.InvalidToken as exc:
            logger.warning("Refusing NextJS websocket: {}", exc)
            await websocket.close(code=4401, reason="invalid voice token")
            return
        transport = create_browser_transport(websocket)

        # The character is the one on the account, read with the child's
        # profile in one request: picking a character in the web app saves it
        # there first. No memory: memory belongs to a board, and the
        # playground is not one (P1-12), so it neither reads nor writes any.
        profile = await fetch_user_personality(user_id)
        ip = profile.ip
        logger.info(
            "NextJS websocket connected user={} character={}",
            user_id,
            profile.title or "default",
        )
        # What ties a turn_metrics row to the conversation it was measured in.
        chat_group_id = str(uuid.uuid4())
        child = {
            "name": profile.child_name,
            "age": profile.child_age,
            "persona": profile.child_persona,
            "personality_key": profile.personality_key,
        }

        await run_bot_session(
            transport,
            "browser",
            False,
            tts_voice=profile.tts_voice,
            tts_voices=profile.tts_voices,
            title=profile.title,
            character_prompt=profile.character_prompt,
            voice_prompt=profile.voice_prompt,
            first_message_prompt=profile.first_message_prompt,
            memory=None,
            child=child,
            user_id=profile.user_id,
            chat_group_id=chat_group_id,
            language_code=profile.language_code,
            region=profile.region,
            ip=ip,
            mode_key=profile.mode_key,
            style_key=profile.style_key,
        )

    @app.websocket("/ws/esp32")
    async def esp32_websocket(websocket: WebSocket):
        await websocket.accept()
        # Who this is comes from the device token alone. Accept first, then
        # close with 4401, so the board sees a close code it can act on (fetch
        # a new token) rather than a bare failed handshake.
        try:
            device = device_auth.verify(
                device_auth.bearer(websocket.headers.get("authorization"))
            )
        except device_auth.InvalidToken as exc:
            logger.warning(
                "Refusing ESP32 websocket: {} (X-Device-Mac claims {})",
                exc,
                websocket.headers.get("x-device-mac") or "nothing",
            )
            await websocket.close(code=4401, reason="invalid device token")
            return
        mac_address = device.mac
        logger.info(
            "ESP32 websocket connected: device={} mac={} rssi={}",
            device.device_id,
            mac_address,
            websocket.headers.get("x-wifi-rssi", "unknown"),
        )
        # The device has no query string to carry a character on, so resolve the
        # one assigned to it in Supabase. This fails open to the defaults.
        personality = await fetch_device_personality(mac_address)
        # A device token lives 24 hours and the board only fetches a new one
        # when it expires or is refused, so a board unbound a minute ago still
        # holds a valid one. Refuse it here, before "auth" is sent: the board
        # takes a close before auth as a refused token, asks for a new one,
        # gets 202 and goes back to waiting to be claimed. Only a known
        # unclaimed row counts -- a failed lookup (claimed is None) still fails
        # open, as everything else here does.
        if personality.claimed is False and not ALLOW_UNCLAIMED_DEVICES:
            logger.warning(
                "Refusing ESP32 websocket: device {} ({}) is not claimed by any account",
                device.device_id,
                mac_address,
            )
            await websocket.close(code=4401, reason="device not claimed")
            return
        await websocket.send_text(
            json.dumps(create_esp32_auth_message(volume=personality.volume))
        )
        transport = create_esp32_transport(websocket)

        # Memory is keyed by the account the device is claimed by, the device
        # itself and the character's IP: each board on an account remembers
        # its own child, and one IP never hears what was told to another. The
        # device comes from the verified token, never from the client.
        memory = await memory_session.acquire(
            personality.user_id,
            device.device_id,
            personality.ip.ip_key if personality.ip else None,
            personality.language_code,
            personality.memories_revision,
        )
        # Same reasoning as the browser route: the id exists for the metrics
        # even when there is no memory to attach it to.
        chat_group_id = str(uuid.uuid4())
        if memory is not None:
            memory.chat_group_id = chat_group_id
            memory.timezone = personality.region.timezone if personality.region else None
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
                tts_voices=personality.tts_voices,
                title=personality.title,
                character_prompt=personality.character_prompt,
                voice_prompt=personality.voice_prompt,
                memory=memory,
                child=child,
                user_id=personality.user_id,
                chat_group_id=chat_group_id,
                language_code=personality.language_code,
                region=personality.region,
                ip=personality.ip,
                mode_key=personality.mode_key,
                style_key=personality.style_key,
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
