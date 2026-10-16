# Event Music System — runs on Bun.
FROM oven/bun:1-alpine

ENV TZ=Asia/Bangkok
RUN apk add --no-cache tzdata \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo "$TZ" > /etc/timezone

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# App source.
COPY server.js ./
COPY LICENSE ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=45416
EXPOSE 45416

CMD ["bun", "server.js"]
