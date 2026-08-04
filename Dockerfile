# Image legere Node.js
FROM node:18-slim

# Installation de Chromium + dependances systeme necessaires a Puppeteer sous Linux
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# On empeche Puppeteer de telecharger son propre Chromium (inutile : on utilise celui du systeme)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Installation des dependances (avant de copier le reste, pour profiter du cache Docker)
COPY package*.json ./
RUN npm install --omit=dev

# Copie du reste du projet
COPY . .

EXPOSE 8080

# Lancement du bot
CMD ["node", "bot.js"]
