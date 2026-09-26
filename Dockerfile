FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
# Le stockage persistant est monté par Railway sur /data (aucune directive de volume dans l'image).
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
