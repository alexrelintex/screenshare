FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Dependency layer before source, so editing code does not re-run pip install.
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Do not run as root.
RUN useradd --system --uid 10001 app && chown -R app /app
USER app

EXPOSE 8000
# Render and most other PaaS hosts inject $PORT and expect the process to bind
# it. Compose and local runs leave it unset, so the container port stays 8000
# and docker-compose.yml's `${SIGNALING_PORT:-8000}:8000` mapping is unaffected.
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:%s/healthz' % os.environ.get('PORT','8000'))"
# Shell form so ${PORT} expands; `exec` so uvicorn stays PID 1 and receives
# SIGTERM directly instead of the shell swallowing it.
CMD ["sh", "-c", "exec uvicorn signaling.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
