FROM node:20-alpine

# Installer git (nécessaire pour certaines dépendances)
RUN apk add --no-cache git

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances (production uniquement)
RUN npm install --omit=dev

# Copier le code source
COPY . .

# Démarrer le bot
CMD ["node", "bot.js"]