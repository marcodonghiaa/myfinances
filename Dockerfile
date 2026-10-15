FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# last-sync.json is written next to the scripts; the non-root user needs to own the dir.
RUN chown node:node /app
# Sync cursors live on a volume so a container restart doesn't re-pull 90 days of history.
RUN mkdir /data && chown node:node /data
ENV SYNC_STATE_FILE=/data/last-sync.json
USER node
CMD ["node", "scheduler.js"]
