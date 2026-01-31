FROM node:22-bullseye

# System dependencies
RUN apt-get update && apt-get install -y \
  ffmpeg \
  python3 \
  python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Whisper + Torch (CPU)
RUN pip3 install --no-cache-dir openai-whisper \
  torch --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 8080
CMD ["npm", "run", "start"]
