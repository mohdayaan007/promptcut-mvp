FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
RUN npm run build

EXPOSE 8080

CMD ["npm", "run", "start"]
