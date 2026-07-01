# Backend (FastAPI) image for F.E.A.R. The frontend deploys separately (Vercel).
# Python is pinned to 3.11 to match the project.
FROM python:3.11-slim

# Runtime libs some wheels expect (onnxruntime/torch need libgomp).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only PyTorch first — the default torch wheel is a multi-GB CUDA
# build that a small server neither needs nor can fit — then the rest.
COPY requirements.txt ./
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

COPY fear ./fear
COPY prompts ./prompts

# Persistent data (ChromaDB memory + the users SQLite db) lives on a mounted
# volume at /data; everything else in the container is ephemeral.
ENV FEAR_HOST=0.0.0.0 \
    FEAR_PORT=8765 \
    CHROMA_PATH=/data/chroma \
    FEAR_USERS_DB=/data/users.db

EXPOSE 8765
CMD ["uvicorn", "fear.web.app:app", "--host", "0.0.0.0", "--port", "8765"]
