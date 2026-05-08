# Fase 1: Build (Prepariamo il codice)
FROM node:18-slim AS builder
WORKDIR /app

# Copiamo i file dei pacchetti e installiamo le dipendenze
COPY package*.json ./
RUN npm install

# Copiamo tutto il resto e compiliamo il codice TypeScript in JavaScript
COPY . .
RUN npm run build

# Fase 2: Run (Eseguiamo solo quello che serve)
FROM node:18-slim
WORKDIR /app

# Copiamo solo i file necessari dalla fase di build per tenere l'immagine leggera
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/build ./build
RUN npm install --omit=dev

EXPOSE 8080

# Avviamo il file index.js dalla cartella 'build'
CMD ["node", "build/index.js"]
