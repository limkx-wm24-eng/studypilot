FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web/package*.json web/
RUN npm --prefix web ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY web ./web
RUN npm run build:all

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/studypilot.db PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/migrations ./migrations
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server.js"]
