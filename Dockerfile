FROM node:22-bookworm-slim

WORKDIR /app

# Keep the provider integration version-pinned for reproducible production builds.
RUN npm install --global @atomicmail/agent-skill@0.3.26 \
    && npm cache clean --force

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /app/data /app/secrets /app/backups && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    DB_PATH=/app/data/atomicmail-panel.sqlite \
    SECRETS_DIR=/app/secrets \
    DATA_ENCRYPTION_KEY_FILE=/app/secrets/data.key \
    BACKUP_DIR=/app/backups \
    ATOMICMAIL_CLI_COMMAND=atomicmail \
    ATOMICMAIL_CLI_PREFIX_ARGS_JSON=[] \
    ATOMICMAIL_WATCH_MODE=on-demand

VOLUME ["/app/data", "/app/secrets", "/app/backups"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
