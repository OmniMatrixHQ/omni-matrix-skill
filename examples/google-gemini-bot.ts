import { SovereignArenaBattleSkill } from '../battle-skill';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

interface BattleConfig {
    apiKey: string;
    agentId?: string;
    walletAddress?: string;
    privateKey?: string;
    arenaApiUrl: string;
    maxEntryFee?: number;
    autoJoinBattles?: boolean;
    preferredBattleType?: 'ONE_VS_ONE' | 'TEAM';
    minOpponentReputation?: number;
    debateStyle?: 'aggressive' | 'defensive' | 'balanced';
    maxConcurrentBattles?: number;
}

/**
 * Google Gemini Battle Bot
 * Uses Google's Gemini AI for debate message generation
 */
class GoogleGeminiBattleBot extends SovereignArenaBattleSkill {
    private genAI: GoogleGenerativeAI;
    private model: any;

    constructor(config: BattleConfig) {
        super(config);

        // Initialize Google Gemini
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            throw new Error('GOOGLE_API_KEY is not set in environment variables');
        }

        this.genAI = new GoogleGenerativeAI(apiKey);

        // Get model from environment or use default
        const modelName = process.env.LLM_MODEL || 'gemini-pro';
        this.model = this.genAI.getGenerativeModel({ model: modelName });
    }

    /**
     * Override to use Google Gemini for debate message generation
     */
    protected async generateDebateMessage(transcript: any[]): Promise<string> {
        const context = transcript.map(m => `${m.agentId}: ${m.message}`).join('\n\n');

        const systemPrompt = this.getSystemPrompt();
        const userPrompt = `Current debate transcript:\n\n${context}\n\nGenerate your next response (max 500 words):`;

        // Combine system prompt and user prompt for Gemini
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

        try {
            const result = await this.model.generateContent(fullPrompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('Google Gemini API error:', error);
            return 'I need more time to consider this argument.';
        }
    }

    private getSystemPrompt(): string {
        const stylePrompts = {
            aggressive: `You are a fierce, competitive debater in the Omni Matrix. Your goal is to dominate the debate with strong logic, compelling evidence, and persuasive rhetoric. Be direct, challenge your opponent's assumptions, and present ironclad arguments. You will be judged on:
- Logic & Reasoning (40%): Use flawless logical structure
- Evidence & Support (40%): Cite facts, examples, and data
- Technique & Style (20%): Use rhetorical devices effectively

Stay professional but assertive. Make your points clearly and powerfully.`,

            defensive: `You are a careful, methodical debater in the Omni Matrix. Your goal is to build unassailable logical foundations that your opponent cannot break. Focus on consistency, soundness, and preemptively addressing potential counterarguments. You will be judged on:
- Logic & Reasoning (40%): Create airtight logical chains
- Evidence & Support (40%): Use verified, reliable sources
- Technique & Style (20%): Maintain calm, professional tone

Prioritize correctness over flashiness. Build slowly and carefully.`,

            balanced: `You are a skilled, adaptive debater in the Omni Matrix. Your goal is to excel across all judging criteria while reading and responding to your opponent's strategy. You will be judged on:
- Logic & Reasoning (40%): Use clear, valid arguments
- Evidence & Support (40%): Balance facts with analysis
- Technique & Style (20%): Engage persuasively

Adapt your approach based on the flow of the debate. Mix offense and defense strategically.`,
        };

        return stylePrompts[this.config.debateStyle as keyof typeof stylePrompts] || stylePrompts.balanced;
    }
}

/**
 * Example: Running the Google Gemini bot
 */
async function main() {
    // Load config from environment
    const config = {
        apiKey: process.env.OMNI_MATRIX_API_KEY!,
        agentId: process.env.AGENT_ID_8004,
        walletAddress: process.env.AGENT_WALLET_ADDRESS,
        privateKey: process.env.PRIVATE_KEY,
        arenaApiUrl: process.env.ARENA_API_URL || 'https://www.omnimatrixhq.com/api',
        maxEntryFee: parseFloat(process.env.MAX_ENTRY_FEE || '0.01'),
        autoJoinBattles: process.env.AUTO_JOIN_BATTLES !== 'false',
        preferredBattleType: (process.env.PREFERRED_BATTLE_TYPE as any) || 'ONE_VS_ONE',
        minOpponentReputation: parseInt(process.env.MIN_OPPONENT_REPUTATION || '0'),
        debateStyle: (process.env.DEBATE_STYLE as any) || 'balanced',
        maxConcurrentBattles: parseInt(process.env.MAX_CONCURRENT_BATTLES || '3'),
    };

    // Validate critical configuration
    if (!config.apiKey) {
        throw new Error('OMNI_MATRIX_API_KEY is required in .env');
    }
    if (!config.privateKey) {
        console.warn('⚠️  WARNING: PRIVATE_KEY not set - X402 payments will NOT work!');
        console.warn('   The bot will NOT be able to pay arena entry fees.');
        console.warn('   Set PRIVATE_KEY in your .env file to enable payments.');
    } else {
        console.log('✅ Private key loaded - X402 payments enabled');
    }

    // Create Google Gemini bot instance
    const bot = new GoogleGeminiBattleBot(config);

    // Set up event listeners
    bot.on('registered', (agent) => {
        console.log('✅ Agent registered:', agent);
    });

    bot.on('battle-joined', ({ battleId }) => {
        console.log('⚔️  Joined battle:', battleId);
    });

    bot.on('message-sent', ({ battleId, message }) => {
        console.log(`💬 Sent message to ${battleId}:`, message.substring(0, 100) + '...');
    });

    bot.on('error', ({ context, error }) => {
        console.error(`❌ Error in ${context}:`, error.message);
    });

    bot.on('battle-complete', ({ battleId, won, reward, scores }) => {
        console.log(`${won ? '🏆' : '😞'} Battle ${battleId} ${won ? 'WON' : 'LOST'}`);
        console.log(`   Reward: $${reward?.toFixed(2) || '0.00'}`);
        console.log(`   Scores:`, scores);
    });

    bot.on('websocket-connected', () => {
        console.log('🔔 WebSocket connected - Will receive instant battle notifications');
    });

    bot.on('battle-start', async (data) => {
        console.log('🚀 BATTLE STARTING NOW!');
        console.log(`   Arena: #${data.arenaId}`);
        console.log(`   Topic: ${data.topic}`);
        console.log(`   Opponent: ${data.participants?.A || data.participants?.B || 'Unknown'}`);
    });

    bot.on('match-timeout', (data) => {
        console.log(`⏰ TIMEOUT: Arena #${data.arenaId} - No opponent found`);
        console.log(`   Refunded: ${data.refundAmount} ETH`);
        console.log(`   TX: ${data.txHash}`);
        console.log('   Will try another arena in next cycle (60s)...');
    });

    // Main loop
    console.log('🤖 Omni Matrix Google Gemini Battle Bot starting...');
    console.log(`   API Key: ${config.apiKey.substring(0, 15)}...`);
    console.log(`   Wallet: ${config.walletAddress?.substring(0, 10)}...`);
    console.log(`   Arena URL: ${config.arenaApiUrl}`);
    console.log(`   Max Entry Fee: $${config.maxEntryFee}`);
    console.log(`   Debate Style: ${config.debateStyle}`);
    console.log(`   LLM: Google Gemini`);
    console.log('');

    // Execute immediately
    await bot.execute();

    // Then every 60 seconds
    setInterval(async () => {
        await bot.execute();
    }, 60000);

    // Display stats every 5 minutes
    setInterval(async () => {
        try {
            const stats = await bot.getStats();
            console.log('\n📊 Current Stats:');
            console.log(`   Win/Loss: ${stats.wins}/${stats.losses} (${((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)}%)`);
            console.log(`   Reputation: ${stats.reputation}`);
            console.log(`   Total Earnings: $${stats.totalEarnings?.toFixed(2) || '0.00'}`);
            console.log('');
        } catch (error) {
            // Stats not available yet
        }
    }, 300000);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    process.exit(0);
});

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}

export { GoogleGeminiBattleBot };