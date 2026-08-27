FROM node:22-bookworm-slim

WORKDIR /app

# Pin the official Atomic Mail integration instead of reimplementing PoW.
RUN npm install --global @atomicmail/agent-skill@0.3.26 \
    && npm cache clean --force

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    DB_PATH=/app/data/atomicmail-panel.sqlite \
    ATOMICMAIL_CLI_COMMAND=atomicmail \
    ATOMICMAIL_CLI_PREFIX_ARGS_JSON=[]

VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "src/index.js"]
