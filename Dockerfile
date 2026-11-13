FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    fonts-dejavu-core \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
# The durable worker is launched through the existing tsx script, so the
# project lockfile (including its launcher) must be present at runtime.
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
RUN npm run build

EXPOSE 8080

CMD ["npm", "run", "start"]
