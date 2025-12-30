FROM node:20
WORKDIR /app
COPY . .
ARG INSTALL_CHROMIUM=true
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
    apt-get update && \
    apt-get install -y wget ca-certificates gnupg && \
    rm -f /etc/apt/trusted.gpg && \
    wget -O- https://ftp-master.debian.org/keys/archive-key-12.asc | gpg --dearmor > /etc/apt/trusted.gpg.d/debian-archive-key-12.gpg && \
    apt-get update && \
    apt-get install -y chromium && \
    echo 'export PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"' >> /etc/profile.d/chromium.sh; \
fi
RUN npm install
RUN npm run build
CMD ["/bin/sh", "-c", "node dist/index.js"]
