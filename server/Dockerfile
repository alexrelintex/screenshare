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
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz')"
CMD ["uvicorn", "signaling.main:app", "--host", "0.0.0.0", "--port", "8000"]
