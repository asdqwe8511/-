FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fibo_alert ./fibo_alert
COPY config.yaml .
ENV PYTHONUNBUFFERED=1
VOLUME /app/data
# DISCORD_WEBHOOK_URL 은 환경변수로만 전달(이미지에 넣지 않음)
CMD ["python", "-m", "fibo_alert", "run", "-c", "config.yaml"]
