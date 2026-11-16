FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    fonts-dejavu-core \
    fonts-liberation \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CLIPONAUT_MKL_PYTHON=/opt/cliponaut-mkl-venv/bin/python \
    CLIPONAUT_MKL_RUNNER=/app/scripts/founder-mkl-local-evaluation.py
WORKDIR /app

COPY package*.json ./
RUN npm ci

# The original MKL evaluator is a separate GPL-3.0 Python component. It is
# isolated in its own venv and remains release-gated by the Node worker.
COPY python/mkl-runtime-requirements.txt /tmp/mkl-runtime-requirements.txt
RUN python3 -m venv /opt/cliponaut-mkl-venv \
    && /opt/cliponaut-mkl-venv/bin/pip install --no-deps --require-hashes -r /tmp/mkl-runtime-requirements.txt \
    && install -D /opt/cliponaut-mkl-venv/lib/python3.11/site-packages/color_matcher-0.6.0.dist-info/LICENSE /usr/share/licenses/color-matcher/LICENSE

COPY . .

RUN /opt/cliponaut-mkl-venv/bin/python scripts/founder-mkl-local-evaluation.py --runtime-check
RUN install -D docs/MKL_GPL_COMPONENT.md /usr/share/doc/cliponaut-mkl/GPL-COMPONENT.md

ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
RUN npm run build

EXPOSE 8080

CMD ["npm", "run", "start"]
