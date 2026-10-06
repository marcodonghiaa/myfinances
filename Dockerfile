FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# last-sync.json is written next to the scripts; the non-root user needs to own the dir.
RUN chown node:node /app
USER node
CMD ["node", "scheduler.js"]
