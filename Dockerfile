FROM node:20
WORKDIR /app
RUN apt-get update
RUN apt-get install -y wget ca-certificates gnupg build-essential python3 make gcc g++
RUN wget -O- https://ftp-master.debian.org/keys/archive-key-12.asc | gpg --dearmor > /etc/apt/trusted.gpg.d/debian-archive-key-12.gpg
RUN apt-get update
RUN apt-get install -y chromium
RUN rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY . .
RUN rm -rf node_modules
RUN npm explore sharp -- npm run build
RUN npm install node-addon-api node-gyp
RUN npm install
RUN npm run build
CMD ["/bin/sh", "-c", "node dist/index.js"]
