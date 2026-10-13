# syntax=docker/dockerfile:1.7
# Bean Garden — one container, accounts mode (PLATFORM.md §10.2). Behind Caddy (docker-compose.yml) or a PaaS edge.
# Pin the base image by digest in CI:  FROM node:24.19.0-bookworm-slim@sha256:<digest>
FROM node:24.19.0-bookworm-slim AS base

# --disable-proto=throw: no __proto__ gadget at runtime. No --inspect / heap-snapshot flags (§5.3 rule 7).
# UV_THREADPOOL_SIZE=8: scrypt runs on the libuv threadpool (§2.2).
ENV NODE_ENV=production NODE_OPTIONS=--disable-proto=throw UV_THREADPOOL_SIZE=8
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY web ./web

RUN mkdir -p /data && chown node:node /data
USER node

# Render (render.yaml): the platform's PORT (10000) replaces this one at run time; the VOLUME is not mounted there, so
# /data is the EPHEMERAL container disk (owned by node, writable) and server/cloudsync.js keeps the durable copy in a
# private Supabase Storage bucket (deploy/render/README.md).
ENV HOST=0.0.0.0 PORT=8420 BEAN_DATA_DIR=/data
EXPOSE 8420
VOLUME ["/data"]
STOPSIGNAL SIGTERM

# A separate `node -e` process: the egress guard lives only in the server process. /readyz on 127.0.0.1 is exempt
# from the Host check (§4.4).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The mode is passed explicitly: an empty or overridden BEAN_AUTH can never drop the image into none mode.
CMD ["node", "server/main.js", "--auth", "accounts"]
