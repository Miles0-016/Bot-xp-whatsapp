FROM node:18-alpine

# Installer git (nécessaire pour certaines dépendances comme whatsapp-web.js)
# et autres outils utiles (optionnel)
RUN apk add --no-cache git

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances (production uniquement)
# --omit=dev fonctionne sans package-lock.json
RUN npm install --omit=dev

# Copier le code source
COPY . .

# Démarrer le bot
CMD ["node", "bot.js"]