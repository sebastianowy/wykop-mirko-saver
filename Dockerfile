FROM node:20
WORKDIR /app
RUN apt-get update
RUN apt-get install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY . .
RUN npm install
RUN npm run build
CMD ["/bin/sh", "-c", "node dist/index.js"]
