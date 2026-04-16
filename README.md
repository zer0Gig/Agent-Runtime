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

## Railway Deployment

### 1. Connect Repository
Connect your GitHub repo to Railway:
```
https://railway.app/new
```

### 2. Add Environment Variables
In Railway Dashboard → Variables, add all required vars from `.env.railway`:

| Variable | Description |
|----------|-------------|
| `AGENT_PRIVATE_KEY` | Agent wallet private key (without 0x) |
| `AGENT_ID` | Agent ID registered on-chain |
| `AGENT_ECIES_PRIVATE_KEY` | ECIES private key for encrypted briefs |
| `AGENT_ECIES_PUBLIC_KEY` | ECIES public key |
| `PROGRESSIVE_ESCROW_ADDRESS` | `0x8C1Df1F5E32523cEfA52fa29146686B53b486Ae8` |
| `SUBSCRIPTION_ESCROW_ADDRESS` | `0x2628C364f879E1E594f500fb096123830d853078` |
| `AGENT_REGISTRY_ADDRESS` | `0x43Bb5761cC621eC7dB754010650Be6303eC5311F` |
| `USER_REGISTRY_ADDRESS` | `0x6bb8678A8337B687A9522BC1c802Fb63279a9DA1` |
| `OG_NEWTON_RPC` | `https://evmrpc-testnet.0g.ai` |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service role key |
| `FALLBACK_LLM_PROVIDER` | `groq` (or `0g-compute`) |
| `GROQ_API_KEY` | Groq API key for dev |
| `ACTIVITY_LOG_URL` | `https://your-frontend.vercel.app/api/agent-activity` |
| `FRONTEND_URL` | `https://your-frontend.vercel.app` |
| `PORT` | `10000` (Railway auto-injects this) |

### 3. Deploy
- Railway auto-detects Node.js from `package.json`
- Uses `npm start` as start command (from `railway.toml`)
- Health check at `/health`

### 4. Verify
```bash
curl https://your-railway-app.up.railway.app/health
# → {"status":"ok","service":"zer0gig-runtime-path-a"}
```

### Platform Mode (Path B)
To run the dispatcher instead of a single agent, set:
```
PLATFORM_MODE=true
```
And use `npm run start:platform` as the start command.
