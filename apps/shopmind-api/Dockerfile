FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shopmind ./shopmind

RUN useradd --create-home --uid 10001 shopmind \
    && mkdir -p /data \
    && chown -R shopmind:shopmind /app /data

USER shopmind

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/live', timeout=3)"

CMD ["uvicorn", "shopmind.main:app", "--host", "0.0.0.0", "--port", "8000"]

