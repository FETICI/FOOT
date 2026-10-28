FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
