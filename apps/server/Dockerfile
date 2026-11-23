# 基础镜像可由部署脚本换成本地镜像站引用（默认官方 node:20-slim）
ARG NODE_IMAGE=node:20-slim
FROM ${NODE_IMAGE}

# 国内网络默认走阿里云 Debian 镜像；海外构建可传 --build-arg DEBIAN_MIRROR=deb.debian.org
ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
      [ -f "$f" ] || continue; \
      sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" "$f"; \
    done; \
    apt-get -o Acquire::ForceIPv4=true update && apt-get -o Acquire::ForceIPv4=true install -y --no-install-recommends \
      python3 make g++ libreoffice-nogui fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN npm config set registry https://registry.npmmirror.com \
    && npm install --workspaces --include-workspace-root
RUN npm run build:shared && npm run build:server
EXPOSE 3001 3002
VOLUME ["/data"]
CMD ["npm", "run", "start", "--workspace=@yunshu/server"]
