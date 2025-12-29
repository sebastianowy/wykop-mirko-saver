FROM node:20
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
CMD ["/bin/sh", "-c", "npm install && npm run build && node dist/index.js"]
