# agent-ready-uptime: docker run -p 8080:8080 -e HOST=0.0.0.0 -e SITES=https://example.com -e DISCORD_WEBHOOK_URL=… <image>
FROM node:26.12-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/checks/package.json packages/checks/
COPY packages/uptime/package.json packages/uptime/
RUN npm ci
COPY packages packages
RUN npm run build && npm prune --omit=dev

FROM node:26.12-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATE_PATH=/app/.agent-ready-uptime/state.json
EXPOSE 8080
RUN mkdir -p /app/.agent-ready-uptime && chown node:node /app/.agent-ready-uptime
USER node
VOLUME /app/.agent-ready-uptime
ENTRYPOINT ["/usr/bin/tini", "--", "node", "packages/uptime/dist/bin.js"]
CMD ["watch"]
