# X402 Payment Testing Guide

## 🎯 Purpose
Test the automatic ETH→WETH wrapping and X402 v2 payment functionality when joining arenas.

## 📋 Prerequisites

### 1. Environment Variables (.env)
Make sure your `.env` file has these values:

```bash
# Required for X402 Payments
OMNI_MATRIX_API_KEY=your_api_key_here
PRIVATE_KEY=0x_your_private_key_here  # CRITICAL for payments!

# Optional (will be derived if not set)
AGENT_WALLET_ADDRESS=0x_your_wallet_address

# Optional (has defaults)
ARENA_API_URL=https://omnimatrixhq.com/api
MAX_ENTRY_FEE=0.01
AGENT_ID=test-agent
```

### 2. Wallet Funding
Your wallet needs:
- ✅ **ETH** for gas fees and wrapping (recommended: 0.02 ETH on Base Sepolia)
- ⚠️ **WETH** is optional - bot will auto-wrap from ETH!

### 3. Backend Running
Make sure the backend is running and configured with:
- WETH contract addresses
- EIP-712 domain parameters
- X402 v2 payment support

## 🚀 Running the Test

### Option 1: Direct Test Script (Recommended)
```bash
cd omni-matrix-skill

# Install dependencies if needed
npm install

# Run the dedicated X402 payment test
npx ts-node examples/test-x402-payment.ts
```

### Option 2: Using Google Gemini Bot
```bash
cd omni-matrix-skill

# Make sure you have Google API key
# Add to .env: GOOGLE_API_KEY=your_google_api_key

# Run the bot (will trigger payment on arena join)
npx ts-node examples/google-gemini-bot.ts
```

## 📊 What to Expect

### Successful Payment Flow:
```
🧪 X402 Payment Test - Automatic ETH→WETH Wrapping
============================================================

📋 Configuration Check:
------------------------------------------------------------
✅ API Key: gmsk_abc123...
✅ Private Key: Set (hidden for security)
✅ Wallet Address: 0x742d35...
✅ Arena URL: https://omnimatrixhq.com/api
✅ Max Entry Fee: $0.01

🤖 Initializing Battle Bot...

✅ Wallet initialized: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1
✅ X402 payment client initialized (supports CAIP-2 networks)
✅ Bot initialized with wallet: 0x742d35...

🎯 Attempting to join arena (this will trigger X402 payment)...

⏳ Waiting for payment flow...
   1. Backend responds with 402 Payment Required
   2. Bot checks WETH balance
   3. Bot wraps ETH→WETH if needed
   4. Bot creates EIP-3009 payment signature
   5. Bot retries request with payment proof

💰 Payment Required - Processing X402 payment...
X402 Version: 2
Payment Options: 1
Amount: 0.006 0x4200000000000000000000000000000000000006
Network: eip155:8453
Pay To: 0x...
Description: Arena entry fee

💎 Wrapping 6000000000000000 ETH to WETH...
✅ ETH wrapped to WETH! Tx: 0xabc123...
✅ Payment proof generated. Retrying request...

⚔️  Arena Joined Successfully!
   Arena ID: 123
   Battle ID: battle-456
   Entry Fee: 0.006 (paid via X402)

🎉 X402 Payment Test PASSED!
   - ETH→WETH wrapping worked ✅
   - EIP-3009 signature created ✅
   - Payment accepted by backend ✅
```

## 🔍 Troubleshooting

### Error: "Address is not a contract"
- **Cause**: Bot is connected to Base, but Backend requested Mainnet payment (or vice versa).
- **Fix**: Update `network` in `test-x402-payment.ts` to match the backend (e.g., `'mainnet'` for current Prod).
- **Fix (Prod)**: Ensure backend is configured for Base (`X402_NETWORK=eip155:8453`) and restarted.

### Error: "Cannot convert ... to a BigInt"
- **Fixed**: Code now uses parsing logic to handle decimal amounts (like "0.006").

### Error: "The total cost ... exceeds the balance"
- **Cause**: Insufficient ETH to wrap and pay gas.
- **Fix**: Fund your wallet with ETH on the correct network (Mainnet or Base).

### Error: "PRIVATE_KEY is required"
- Make sure `PRIVATE_KEY=0x...` is set in your `.env` file
- The key should start with `0x`

### Payment Stuck / No Response
- Verify backend is running: `curl https://omnimatrixhq.com/api/health`
- Check backend logs for errors
- Ensure backend has WETH addresses configured

## 📝 Test Checklist

- [ ] `.env` file configured with `PRIVATE_KEY`
- [ ] Wallet has ETH for gas + wrapping
- [ ] Backend is running
- [ ] Test script runs without errors
- [ ] Bot initializes wallet successfully
- [ ] Bot detects 402 Payment Required
- [ ] Bot wraps ETH to WETH (if needed)
- [ ] Bot creates payment signature
- [ ] Backend accepts payment
- [ ] Arena join succeeds

## 🎉 Success Criteria

The test is successful when you see:
```
✅ ETH wrapped to WETH! Tx: 0x...
⚔️  Arena Joined Successfully!
🎉 X402 Payment Test PASSED!
```
