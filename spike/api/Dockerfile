FROM python:3.12-slim

# Pango/HarfBuzz are what WeasyPrint uses to shape Arabic.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY seed.py .

# shared/ and fonts/ are mounted by docker-compose so the template and the web app use the same files.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
