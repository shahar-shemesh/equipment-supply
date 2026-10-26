# check=skip=SecretsUsedInArgOrEnv
# (the build's own lint flags the ARG VITE_MUI_X_LICENSE_KEY below, see the comment on it. a parser directive has to be the first line)

# the image of the shared test box (docs/deploy-test.md): the api and the built client in one process and one origin.
# build from the repo root: docker build -t equipment-supply:test .
#
# generic on purpose. it sets neither NODE_ENV nor ENVIRONMENT: NODE_ENV=production would lock the mock login out for good
# (server/src/env.ts), and what a box is belongs to the box. render.yaml carries the test box values, docker run -e does
# the same by hand

# 1. the client. it imports ../shared (the contracts and the Hebrew dictionary), so shared/ sits next to client/ like in the repo
FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY shared /app/shared
COPY client ./
# vite bakes VITE_* into the bundle, the grid draws a watermark without a key. Render turns the env vars of a service into
# build args, so a key set there reaches this line; it is in the shipped bundle either way, it is not a secret of the server
ARG VITE_MUI_X_LICENSE_KEY
RUN npm run build

# 2. the server. nest-cli's sourceRoot is server/src because ../shared is compiled too: the output is dist/server/src and
# dist/shared. prune leaves what runs, and the typeorm cli of migration:run:prod is a dependency, not a dev one
FROM node:20-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY shared /app/shared
COPY server ./
RUN npm run build && npm prune --omit=dev

# 3. what runs. no source, no dev dependencies, no .env (.dockerignore), not root
FROM node:20-alpine
WORKDIR /app/server
COPY --from=server /app/server/package.json ./
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=client /app/client/dist /app/client/dist
# the one switch that makes the server serve the client (server/src/env.ts)
ENV CLIENT_DIST=/app/client/dist
USER node
# PORT is read by the server, 3000 without it. Render sets its own
EXPOSE 3000
# the migrations go first and a failed one stops the container before the server listens. exec so node is pid 1 and gets
# the SIGTERM of a stop or a redeploy (enableShutdownHooks), not a shell that swallows it
CMD ["sh", "-c", "npm run migration:run:prod && exec node dist/server/src/main.js"]
