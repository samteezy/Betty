# Betty, for running at home.
#
# Built for the HTTP transport — a container serving stdio would have nothing to
# talk to. The image defaults to `BETTY_TRANSPORT=http` on port 8765 and binds
# 0.0.0.0 *inside the container*, which is not the same as exposing it: publish
# the port to 127.0.0.1 and put a tunnel in front. See docker-compose.yml.
#
# Nothing here is Betty-specific beyond that. She has one runtime dependency,
# so the image is Node, dist/, and the MCP SDK.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV BETTY_TRANSPORT=http \
    BETTY_HTTP_HOST=0.0.0.0 \
    BETTY_HTTP_PORT=8765
EXPOSE 8765

# Betty's own health endpoint. No curl in the image, and no need for one —
# Node has fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.BETTY_HTTP_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Unprivileged, as the base image already provides. With NOTES_BACKEND=local
# this uid has to be able to write the mounted notes directory — see the `user:`
# note in docker-compose.yml if yours is owned by someone else.
USER node

CMD ["node", "dist/index.js"]
