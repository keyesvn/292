FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-driver python3 python3-selenium \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY src ./src
COPY scripts/refresh-proton.py ./scripts/refresh-proton.py
RUN /usr/bin/python3 -c "import selenium" \
  && /usr/bin/chromium --version \
  && /usr/bin/chromedriver --version
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/accounts.sqlite
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
