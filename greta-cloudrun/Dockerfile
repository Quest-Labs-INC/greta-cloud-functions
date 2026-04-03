# Greta Cloud Run Container - Vite Dev Server with HMR + Python Backend + MongoDB + Playwright
# Use Debian-based image for easier MongoDB installation
FROM node:20-slim

# Install useful tools + Python + MongoDB + Playwright dependencies + unzip (for Bun) + lz4 (fast decompression) + util-linux (for ionice)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    gnupg \
    unzip \
    lz4 \
    util-linux \
    python3 \
    python3-pip \
    python3-venv \
    # Playwright dependencies for Chromium
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Install MongoDB from official repo
RUN curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg \
    && echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list \
    && apt-get update \
    && apt-get install -y mongodb-org \
    && rm -rf /var/lib/apt/lists/*

# Create Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Create MongoDB data directory
RUN mkdir -p /data/db && chown -R node:node /data/db

# Set working directory
WORKDIR /app

# Create directories for templates and project
RUN mkdir -p /frontend-template /backend-template /app/project/frontend /app/project/backend

# Copy frontend template (TypeScript + shadcn/ui)
COPY main-template/frontend/ /frontend-template/

# Copy backend template (Python FastAPI)
COPY main-template/backend/ /backend-template/

# Install Python dependencies in backend template
WORKDIR /backend-template
RUN pip install --no-cache-dir -r requirements.txt

# Install Bun for fast package management
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Pre-populate bun cache at build time (no node_modules in image)
# At runtime, bun install uses this cache for fast offline installs (~5-10s)
WORKDIR /frontend-template
RUN bun install && \
    tar -cf - -C /root/.bun/install cache | lz4 -9 > /bun-cache.tar.lz4 && \
    rm -rf node_modules && \
    rm -rf /root/.bun/install/cache

# Go back to app directory
WORKDIR /app

# Copy server files
COPY package.json ./
RUN npm install

# Install Playwright with Chromium only (smaller than all browsers)
RUN npx playwright install chromium --with-deps

COPY server.js ./
COPY lib/ ./lib/

# Environment variables
ENV NODE_ENV=development
ENV PORT=8080
ENV VITE_PORT=5173
ENV BACKEND_PORT=8000
ENV MONGO_PORT=27017
ENV FRONTEND_TEMPLATE_DIR=/frontend-template
ENV BACKEND_TEMPLATE_DIR=/backend-template
# MongoDB Atlas connection (can be overridden at runtime)
ENV MONGO_URL=mongodb+srv://tmxsmoke:aminocentesis@cluster0.zmgremb.mongodb.net/chat-testing?retryWrites=true&w=majority&appName=Cluster0
ENV DB_NAME=chat-testing

# Expose ports
# 8080 = Express API (orchestrator)
# 5173 = Vite Dev Server
# 8000 = Python Backend
# 27017 = MongoDB
EXPOSE 8080 5173 8000 27017

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start the server
CMD ["node", "server.js"]

