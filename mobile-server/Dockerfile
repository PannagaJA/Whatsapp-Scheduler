FROM node:20-slim

WORKDIR /app

# Install build dependencies for native modules (sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create persistent storage directories with non-root ownership (UID 1000)
RUN mkdir -p /var/data/uploads /var/data/sessions /app/data && \
    chown -R node:node /app /var/data && \
    chmod 750 /var/data /app/data

# Run container as non-root user
USER node

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Container healthcheck using public health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
