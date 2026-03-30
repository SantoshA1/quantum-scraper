# ── Playwright base image (includes Chromium + all system deps) ──
FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app

# Copy package files first (Docker layer caching)
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy app code
COPY app.js ./

# Railway injects PORT env var — default 8080
ENV PORT=8080

# Run as non-root for security
USER pwuser

EXPOSE 8080

CMD ["node", "app.js"]
