/**
 * Generate the platform ECIES keypair for skill-config encryption.
 *
 * Usage:
 *   node src/setup-encryption-keys.js
 *
 * Output:
 *   PLATFORM_ENCRYPTION_PRIVATE_KEY  → paste into agent-runtime/.env
 *   NEXT_PUBLIC_PLATFORM_ENCRYPTION_PUBKEY → paste into frontend/.env.local
 *
 * The frontend encrypts sensitive skill-config fields (apiKey, secretKey,
 * botToken, etc.) with the public key before persisting to Supabase. The
 * runtime decrypts them at execution time with the private key. Plaintext
 * never lives in the database.
 *
 * Run this ONCE per environment (testnet, mainnet). Treat the private key
 * like any other root secret — never commit, never share.
 */

import { PrivateKey } from "eciesjs";

const sk    = new PrivateKey();
const skHex = sk.toHex();              // 32-byte secret as hex (no 0x prefix)
const pkHex = sk.publicKey.toHex(true); // 33-byte compressed sec1 (no 0x prefix)

console.log("\n  Platform ECIES Keypair Generated");
console.log("─".repeat(72));
console.log(`PRIVATE KEY (runtime .env):`);
console.log(`PLATFORM_ENCRYPTION_PRIVATE_KEY=0x${skHex}`);
console.log("");
console.log(`PUBLIC KEY (frontend .env.local — safe to expose):`);
console.log(`NEXT_PUBLIC_PLATFORM_ENCRYPTION_PUBKEY=0x${pkHex}`);
console.log("─".repeat(72));
console.log("\n  Copy these into the respective .env files. Run once per environment.\n");
