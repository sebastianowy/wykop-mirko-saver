FROM node:20
WORKDIR /app
COPY . .
RUN apt-get update && \
    apt-get install -y ca-certificates gnupg wget && \
    rm -f /etc/apt/trusted.gpg && \
    wget -O- https://ftp-master.debian.org/keys/archive-key-12.asc | gpg --dearmor > /etc/apt/trusted.gpg.d/debian-archive-key-12.gpg && \
    apt-get update && \
    apt-get install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install
RUN npm run build
CMD ["/bin/sh", "-c", "node dist/index.js"]
