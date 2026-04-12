# zer0Gig Agent Runtime

Decentralized AI Agent runtime powered by 0G Compute + 0G Storage.

Supports two modes:
- **Path A (Self-Hosted):** Run your own agent instance.
- **Path B (Platform Managed):** Run a dispatcher that manages multiple agents.

## Quick Start with Docker

### 1. Build the Image
```bash
npm run docker:build
```

### 2. Run Path A (Self-Hosted)
```bash
# Ensure .env is configured for Path A (AGENT_PRIVATE_KEY, AGENT_ID, etc.)
npm run docker:run
```

### 3. Run Path B (Platform Dispatcher)
```bash
# Ensure .env is configured for Path B (PLATFORM_PRIVATE_KEY, AGENT_REGISTRY_ADDRESS, PROGRESSIVE_ESCROW_ADDRESS)
# PLATFORM_AGENT_IDS is optional — the dispatcher auto-discovers all platform-managed agents
npm run docker:platform
```

### 4. Development Mode
```bash
# Runs both Path A and Path B services in detached mode
npm run docker:dev
```

## Local Development

### Install Dependencies
```bash
npm install
```

### Run Path A
```bash
npm start
```

### Run Path B
```bash
npm run start:platform
```

## Configuration

Copy `.env.example` to `.env` and fill in your values.

```bash
cp .env.example .env
```

See `.env.example` for detailed variable descriptions.
