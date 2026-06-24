FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
# Install system deps: CJK fonts + build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk fonts-freefont-ttf \
    build-essential python3 && \
    rm -rf /var/lib/apt/lists/* && \
    # Clear matplotlib font cache so it picks up Noto CJK at runtime
    python3 -c "import matplotlib; import shutil; shutil.rmtree(matplotlib.get_cachedir(), ignore_errors=True)"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=builder /app/dist ./dist
COPY renderer ./renderer
COPY package*.json ./
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
