FROM oven/bun:latest

WORKDIR /app
COPY . .

RUN bun install --production

EXPOSE 8080
CMD ["bun", "run", "packages/server/src/index.ts"]
