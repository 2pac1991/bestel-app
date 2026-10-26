FROM node:22-alpine
ENV TZ=Europe/Vienna DATA_DIR=/data NODE_ENV=production
RUN apk add --no-cache tzdata
WORKDIR /app
COPY server.mjs .
VOLUME /data
CMD ["node", "server.mjs"]
