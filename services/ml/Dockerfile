# syntax=docker/dockerfile:1

FROM python:3.11.10-slim-bookworm

# ffmpeg backs faster-whisper's audio decoding; libgl and libglib are required
# by opencv, which rapidocr-onnxruntime depends on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# CPU wheels only. The default PyPI torch build carries CUDA kernels that
# cannot run here and would inflate the image by several gigabytes.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
      torch==2.14.0 torchvision==0.29.0

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
