# Movies Made Easy — zero-dependency Node app, so no build/install step.
FROM node:22-alpine

# tzdata lets Intl resolve the Australia/Sydney timezone the server relies on.
RUN apk add --no-cache tzdata

WORKDIR /app

# App source + the runtime fallback data (used only if the live API is blocked).
COPY server.js ./
COPY public ./public
COPY GetSessions.json ./

ENV NODE_ENV=production \
    PORT=3000 \
    CACHE_TTL_MS=60000

EXPOSE 3000

# Drop to the image's built-in non-root user.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
