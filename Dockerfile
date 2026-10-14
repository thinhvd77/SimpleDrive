FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && groupadd -g 10001 simpledrive && useradd -u 10001 -g simpledrive -M simpledrive \
    && mkdir -p /data/files && chown -R simpledrive:simpledrive /data
COPY --from=build /app/dist/server ./dist/server
USER simpledrive
EXPOSE 4000
CMD ["node", "dist/server/main.js"]

FROM nginx:1.28-alpine AS web
RUN addgroup -g 10001 simpledrive
COPY ops/nginx.conf /etc/nginx/nginx.conf
COPY ops/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/web /usr/share/nginx/html
