FROM node:18-alpine

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances (seulement production)
RUN npm ci --only=production

# Copier le code source
COPY . .

# Démarrer le bot
CMD ["node", "bot.js"]