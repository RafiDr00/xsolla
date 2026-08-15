# Multi-stage: compile with dev dependencies, ship only production dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Job snapshots live here. On a host with a mounted volume this survives a restart; on
# Render's free plan there is no disk, so it survives only as long as the container does.
# Owned by `node`, because the process below is unprivileged - without the chown every
# snapshot write fails with EACCES (silently, since persistence is best-effort).
RUN mkdir -p /data && chown node:node /data
ENV JOB_STORE_PATH=/data/jobs.json
ENV PORT=8080
EXPOSE 8080

# Run unprivileged.
USER node

CMD ["node", "dist/server.js"]
