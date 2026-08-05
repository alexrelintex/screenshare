# Two stages: build the bundle with the full toolchain, ship only the output.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY demo ./demo
COPY serve.mjs ./

RUN useradd --system --uid 10002 app && chown -R app /app
USER app

# Bind all interfaces: a loopback bind inside the container makes the port
# Docker publishes unreachable from the host.
ENV HOST=0.0.0.0
EXPOSE 5173
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://localhost:5173/demo/index.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "serve.mjs"]
