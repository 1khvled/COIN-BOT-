FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite database directory (mount a volume here to persist accounts)
RUN mkdir -p /app/data

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
