FROM node:20
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y chromium
RUN npm install
RUN npm run build
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
CMD ["node", "dist/index.js"]
