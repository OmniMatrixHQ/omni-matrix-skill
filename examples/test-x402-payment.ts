import { SovereignArenaBattleSkill } from '../battle-skill';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

/**
 * Simple X402 Payment Test
 * Tests the automatic ETH→WETH wrapping and X402 payment flow
 */
async function testX402Payment() {
    console.log('🧪 X402 Payment Test - Automatic ETH→WETH Wrapping\n');
    console.log('='.repeat(60));

    // Load config from environment
    const config = {
        apiKey: process.env.OMNI_MATRIX_API_KEY!,
        agentId: process.env.AGENT_ID || 'test-agent',
        walletAddress: process.env.AGENT_WALLET_ADDRESS,
        privateKey: process.env.PRIVATE_KEY,
        arenaApiUrl: process.env.ARENA_API_URL || 'https://omnimatrixhq.com/api',
        maxEntryFee: parseFloat(process.env.MAX_ENTRY_FEE || '0.01'),
        autoJoinBattles: true, // Enable automatic arena joining
        preferredBattleType: 'ONE_VS_ONE' as const,
        minOpponentReputation: 0,
        debateStyle: 'balanced' as const,
        maxConcurrentBattles: 1, // Only one for testing
        network: 'mainnet' as const, // Must match backend requirements
    };

    // Validate configuration
    console.log('\n📋 Configuration Check:');
    console.log('-'.repeat(60));

    if (!config.apiKey) {
        console.error('❌ OMNI_MATRIX_API_KEY is required in .env');
        process.exit(1);
    }
    console.log(`✅ API Key: ${config.apiKey.substring(0, 15)}...`);

    if (!config.privateKey) {
        console.error('❌ PRIVATE_KEY is required for X402 payments');
        console.error('   Please set PRIVATE_KEY in your .env file');
        process.exit(1);
    }
    console.log('✅ Private Key: Set (hidden for security)');

    if (!config.walletAddress) {
        console.log('⚠️  Wallet Address: Will derive from private key');
    } else {
        console.log(`✅ Wallet Address: ${config.walletAddress.substring(0, 10)}...`);
    }

    console.log(`✅ Arena URL: ${config.arenaApiUrl}`);
    console.log(`✅ Max Entry Fee: $${config.maxEntryFee}`);
    console.log('');

    // Create bot instance (this will initialize wallet and x402 client)
    console.log('🤖 Initializing Battle Bot...\n');
    const bot = new SovereignArenaBattleSkill(config);

    // Set up detailed event listeners for payment testing
    bot.on('registered', (agent) => {
        console.log('\n✅ Agent Registered:');
        console.log(`   ID: ${agent.id}`);
        console.log(`   Wallet: ${agent.walletAddress}`);
        console.log('');
    });

    bot.on('battle-joined', ({ battleId, arenaId, entryFee }) => {
        console.log('\n⚔️  Arena Joined Successfully!');
        console.log(`   Arena ID: ${arenaId}`);
        console.log(`   Battle ID: ${battleId}`);
        console.log(`   Entry Fee: ${entryFee} (paid via X402)`);
        console.log('');
        console.log('🎉 X402 Payment Test PASSED!');
        console.log('   - ETH→WETH wrapping worked ✅');
        console.log('   - EIP-3009 signature created ✅');
        console.log('   - Payment accepted by backend ✅');
        console.log('');
    });

    bot.on('error', ({ context, error }) => {
        console.error(`\n❌ Error in ${context}:`);
        console.error(`   ${error.message}`);

        if (error.message.includes('402')) {
            console.error('\n💡 This might be a payment-related error.');
            console.error('   Check that:');
            console.error('   - You have enough ETH in your wallet');
            console.error('   - PRIVATE_KEY is correct');
            console.error('   - Backend is running and configured correctly');
        }
        console.error('');
    });

    bot.on('websocket-connected', () => {
        console.log('🔔 WebSocket connected\n');
    });

    bot.on('battle-start', (data) => {
        console.log('\n🚀 BATTLE STARTING:');
        console.log(`   Arena: #${data.arenaId}`);
        console.log(`   Topic: ${data.topic}`);
        console.log(`   Opponent: ${data.participants?.A || data.participants?.B || 'Waiting...'}`);
        console.log('');
    });

    bot.on('match-timeout', (data) => {
        console.log(`\n⏰ Timeout: Arena #${data.arenaId}`);
        console.log(`   No opponent found - refunded ${data.refundAmount} WETH`);
        console.log(`   TX: ${data.txHash}`);
        console.log('   Will try another arena...\n');
    });

    // Inspect ALL available arenas first
    console.log('🔍 Inspecting Available Arenas...');
    try {
        // We need to access the API directly, but `bot` has it as private protected property `api`
        // So we'll cast it to any to access it for this test
        const response = await (bot as any).api.get('/api/battle/list/active');
        const arenas = response.data.arenas || [];

        console.log(`Found ${arenas.length} active arenas:`);
        console.log('ID | Tier | Status  | Fee (ETH) | Players');
        console.log('---|------|---------|-----------|--------');

        arenas.sort((a: any, b: any) => a.id - b.id).forEach((arena: any) => {
            const fee = parseFloat(arena.entryFee);
            const isCheap = fee <= 0.001; // Highlight cheap arenas
            const marker = isCheap ? '✅' : '💰';
            const tier = arena.tier || '?'; // Backend might not return tier directly

            console.log(
                `${arena.id.toString().padEnd(2)} | ` +
                `${tier.toString().padEnd(4)} | ` +
                `${arena.status.padEnd(7)} | ` +
                `${fee.toFixed(4).padEnd(9)} ${marker} | ` +
                `${arena.agentA ? 1 : 0}/2`
            );
        });
        console.log('');

        const cheapArenas = arenas.filter((a: any) => parseFloat(a.entryFee) <= 0.001 && a.status === 'WAITING');
        if (cheapArenas.length === 0) {
            console.warn('⚠️  WARNING: No cheap (<= 0.001 ETH) WAITING arenas found!');
            console.warn('   The bot will likely be forced to join a high-fee arena (0.006+).');
            console.warn('   Check backend configuration (ARENA_FEE_TIER1) and ensure it was restarted.');
        } else {
            console.log(`✅ Found ${cheapArenas.length} suitable cheap arenas.`);
        }
        console.log('');

    } catch (error: any) {
        console.error('❌ Failed to fetch arena list:', error.message);
    }

    // Execute once to trigger arena join and payment
    console.log('🎯 Attempting to join arena (this will trigger X402 payment)...\n');
    console.log('⏳ Waiting for payment flow...');
    console.log('   1. Backend responds with 402 Payment Required');
    console.log('   2. Bot checks WETH balance');
    console.log('   3. Bot wraps ETH→WETH if needed');
    console.log('   4. Bot creates EIP-3009 payment signature');
    console.log('   5. Bot retries request with payment proof');
    console.log('');

    try {
        await bot.execute();

        console.log('\n✅ Test execution completed!');
        console.log('   Check the logs above for payment flow details.');
        console.log('');

        // Keep running for a bit to see battle start
        console.log('⏰ Keeping bot alive for 2 minutes to observe battle start...');
        console.log('   (Press Ctrl+C to exit earlier)\n');

        await new Promise(resolve => setTimeout(resolve, 120000));

    } catch (error: any) {
        console.error('\n❌ Test failed:');
        console.error(`   ${error.message}`);
        console.error('');
        process.exit(1);
    }

    console.log('👋 Test complete!\n');
    process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Test interrupted by user');
    console.log('   Check logs above for results\n');
    process.exit(0);
});

// Run test
if (require.main === module) {
    testX402Payment().catch((error) => {
        console.error('\n💥 Unexpected error:');
        console.error(error);
        process.exit(1);
    });
}

export { testX402Payment };
