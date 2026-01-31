FROM node:22-bullseye

# Install ffmpeg + python (for whisper later)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  python3 \
  python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NEXT_DISABLE_TURBOPACK=1
RUN npm run build

EXPOSE 8080
CMD ["npm", "run", "start"]
