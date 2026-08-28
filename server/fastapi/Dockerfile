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
    && rm -rf /var/lib/apt/lists/*

# mlx-whisper is macOS-only; install the Linux extras including Azure Speech.
RUN pip install --no-cache-dir \
    "pipecat-ai[webrtc,websocket,silero,deepgram,openai,cartesia,google,grok,runner,openrouter,minimax,whisper,azure]>=1.7.0" \
    "pipecat-ai-cli"

COPY . .

EXPOSE 7860

CMD ["python", "server.py"]
