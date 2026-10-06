# VoxNote — cloud image.
# Runs the site + every linked account; persist /data on a volume.
FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first for layer caching. ffmpeg-static downloads the Linux ffmpeg
# at install time (needs network).
# scripts/patch-deps.mjs runs from postinstall: it bounds two caches inside the WhatsApp library.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY docker-entrypoint.sh ./
RUN chown -R node:node /app

# Cloud defaults: listen on all interfaces and keep state on /data. Set
# ADMIN_PASSWORD to enable /admin (health only). Mount a persistent volume at
# /data on your host (Railway: "Add Volume" → /data) BEFORE anyone links.
# NOTE: no Docker `VOLUME` instruction here on purpose — Railway rejects it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4599 \
    DATA_DIR=/data

EXPOSE 4599

# The entrypoint makes /data writable by "node" and drops root before starting.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "--experimental-async-context-frame", "src/app.js"]
