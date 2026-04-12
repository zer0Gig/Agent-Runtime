# ── Builder Stage ──────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies (including devDependencies for build if needed)
RUN npm ci

# Copy source code
COPY . .

# ── Runtime Stage ──────────────────────────────────────────────
FROM node:18-alpine AS runtime

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src

# Set ownership to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose default port (if any, though runtime is mostly internal)
# EXPOSE 3000

# Default command (Path A: Self-Hosted)
CMD ["npm", "start"]
