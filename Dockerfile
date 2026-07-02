# Backend (FastAPI) image for F.E.A.R. The frontend deploys separately (Vercel).
# Python is pinned to 3.11 to match the project.
FROM python:3.11-slim

# Runtime lib onnxruntime expects (OpenMP).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No PyTorch: embeddings run on ChromaDB's bundled ONNX MiniLM (onnxruntime),
# which keeps the image small and the memory footprint low.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the ONNX embedding model into the image so the first request doesn't
# have to download it (fast, offline cold starts).
RUN python -c "from chromadb.utils import embedding_functions as e; e.ONNXMiniLM_L6_V2()"

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
