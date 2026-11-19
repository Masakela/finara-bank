# Finara — Node app (SQLite locally, PostgreSQL via DATABASE_URL in production)
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 7080
CMD ["node", "server.js"]
