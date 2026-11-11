# Finara — zero-dependency Node app
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
# Hosts inject PORT; the app reads process.env.PORT (defaults to 7080 locally).
EXPOSE 7080
CMD ["node", "server.js"]
