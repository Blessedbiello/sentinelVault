FROM node:20-slim

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --production=false

# Copy source
COPY . .

# Compile TypeScript (use build config that includes scripts/)
RUN npx tsc --project tsconfig.build.json

# Copy static dashboard files into the compiled output tree so that
# DashboardServer's path.join(__dirname, 'public') resolves correctly at
# runtime (dist/src/dashboard/server.js -> dist/src/dashboard/public/)
RUN cp -r src/dashboard/public dist/src/dashboard/public

# Expose the single HTTP+WebSocket port
EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "dist/scripts/live-dashboard.js"]
