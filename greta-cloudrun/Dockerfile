# Greta Cloud Run Container - Node.js APIs + Python Backend
FROM node:20-slim

# Install useful tools + Python
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Create Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set working directory
WORKDIR /app

# Create directories for templates and project
RUN mkdir -p /backend-template /app/project/backend

# Copy backend template (Python FastAPI)
COPY main-template/backend/ /backend-template/

# Install Python dependencies in backend template
WORKDIR /backend-template
RUN pip install --no-cache-dir -r requirements.txt

# Go back to app directory
WORKDIR /app

# Copy server files
COPY package.json ./
RUN npm install

COPY server.js ./
COPY lib/ ./lib/

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV BACKEND_PORT=8000
ENV BACKEND_TEMPLATE_DIR=/backend-template
# ENV MONGO_URL=mongodb://test-dev:UvDLmyoYBAe8rV4HAGVdnm67Ru6BhtJjXj0oTps5Reanq-Kk@03d6d025-6f60-4619-b1fc-d226dfab6cd5.nam5.firestore.goog:443/test?loadBalanced=true&tls=true&authMechanism=SCRAM-SHA-256&retryWrites=false
# ENV DB_NAME=greta

# Expose ports
# 8080 = Express API (orchestrator)
# 8000 = Python Backend
EXPOSE 8080 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start the server
CMD ["node", "server.js"]
