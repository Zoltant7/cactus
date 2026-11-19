# syntax=docker/dockerfile:1
FROM ghcr.io/home-assistant/base:3.24


# Install Node.js, npm, and vips (runtime dependency for sharp on Alpine)
RUN apk add --no-cache \
    nodejs \
    npm \
    vips

WORKDIR /app

# Install sharp directly into /app/node_modules (no package.json required)
RUN npm install --no-save sharp && npm cache clean --force

# Copy cactus-node.mjs, vendor/, and models/ into /app
COPY app/ ./

# Smoke-check the engine files are present at build time — fail fast.
RUN test -s ./vendor/cactus.js   || (echo "missing vendor/cactus.js"  && false) && \
    test -s ./vendor/cactus.wasm || (echo "missing vendor/cactus.wasm" && false) && \
    test -s ./models/mirage.cact || (echo "missing models/mirage.cact" && false)

# Copy rootfs (including /etc/cont-init.d/ scripts) into the container root
COPY rootfs /
RUN if [ -d /etc/cont-init.d ]; then chmod -R a+x /etc/cont-init.d; fi

EXPOSE 3002

CMD ["node", "cactus-node.mjs", "--serve"]
