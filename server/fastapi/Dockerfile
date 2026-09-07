FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=7860
ENV HOST=0.0.0.0

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    libasound2 \
    libgomp1 \
    libssl3 \
    libsndfile1 \
    libportaudio2 \
    && rm -rf /var/lib/apt/lists/*

# voicemem depends on torch unconditionally (its local E5 embedder runs through
# sentence-transformers), and the default PyPI wheel drags in the whole CUDA
# runtime -- several gigabytes of nvidia-* packages this server will never use.
# Installing the CPU build first means voicemem's own resolve finds torch
# already satisfied and never reaches for the CUDA one.
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch torchaudio torchvision

# mlx-whisper is macOS-only; install the Linux extras including Azure Speech.
RUN pip install --no-cache-dir \
    "pipecat-ai[webrtc,websocket,silero,deepgram,openai,cartesia,google,grok,runner,openrouter,minimax,whisper,azure]>=1.7.0" \
    "pipecat-ai-cli" \
    "voicemem>=0.2.3"

# Bake the embedding model in. Text mode only touches this one -- the ASR, VAD
# and voiceprint models VoiceMem ships are for its audio path, which we do not
# use because Pipecat's STT already produced the transcript.
ENV HF_HOME=/app/.hf
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('intfloat/multilingual-e5-small')"

COPY . .

EXPOSE 7860

CMD ["python", "server.py"]
