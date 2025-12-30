FROM node:20
WORKDIR /app
COPY . .
ARG INSTALL_CHROMIUM=true
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
    apt-get update && \
    apt-get install -y ca-certificates gnupg && \
    apt-get update && \
    apt-get install -y chromium && \
    echo 'export PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"' >> /etc/profile.d/chromium.sh; \
fi
RUN npm install
RUN npm run build
CMD ["/bin/sh", "-c", "node dist/index.js"]
