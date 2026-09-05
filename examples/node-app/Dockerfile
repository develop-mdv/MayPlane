FROM node:24-alpine
WORKDIR /app
COPY server.mjs .
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
