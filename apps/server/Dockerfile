FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libreoffice-nogui fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN npm install --workspaces --include-workspace-root
RUN npm run build:shared && npm run build:server
EXPOSE 3001 3002
VOLUME ["/data"]
CMD ["npm", "run", "start", "--workspace=@yunshu/server"]
