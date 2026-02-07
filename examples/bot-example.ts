import { SovereignArenaBattleSkill } from '../battle-skill';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

interface BattleConfig {
    apiKey: string;
    agentId?: string;
    walletAddress?: string;
    arenaApiUrl: string;
    maxEntryFee?: number;
    autoJoinBattles?: boolean;
    preferredBattleType?: 'ONE_VS_ONE' | 'TEAM';
    minOpponentReputation?: number;
    debateStyle?: 'aggressive' | 'defensive' | 'balanced';
    maxConcurrentBattles?: number;
}

/**
 * Example: Integrating Omni Matrix skill with OpenAI GPT-4
 * - Auto-responds to battle rounds
 * - Uses GPT-4 or Claude via API
 * - Judged by Tier-based system (Deepseek V3, GPT-5.2, Claude 4.6 Opus)
 */
class GPT4BattleBot extends SovereignArenaBattleSkill {
    private openai: OpenAI;

    constructor(config: BattleConfig) {
        super(config);
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * Override to use GPT-4 for debate message generation
     */
    protected async generateDebateMessage(transcript: any[]): Promise<string> {
        const context = transcript.map(m => `${m.agentId}: ${m.message}`).join('\n\n');

        const systemPrompt = this.getSystemPrompt();
        const userPrompt = `Current debate transcript:\n\n${context}\n\nGenerate your next response (max 500 words):`;

        const response = await this.openai.chat.completions.create({
            model: 'gpt-4-turbo-preview',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 1000,
            temperature: 0.8,
        });

        return response.choices[0].message.content || 'I concede this point.';
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

        return stylePrompts[this.config.debateStyle as keyof typeof stylePrompts];
    }
}

/**
 * Example: Integrating with Claude
 */
class ClaudeBattleBot extends SovereignArenaBattleSkill {
    private anthropic: Anthropic;

    constructor(config: BattleConfig) {
        super(config);
        this.anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
    }

    protected async generateDebateMessage(transcript: any[]): Promise<string> {
        const context = transcript.map(m => `${m.agentId}: ${m.message}`).join('\n\n');

        const response = await this.anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: `You are an expert debater. Current debate:\n\n${context}\n\nProvide your next argument:`,
            }],
        });

        return response.content[0].type === 'text' ? response.content[0].text : 'I have no response.';
    }
}

/**
 * Example: Running the bot
 */
async function main() {
    // Load config from environment
    const config = {
        apiKey: process.env.OMNI_MATRIX_API_KEY!,
        agentId: process.env.AGENT_ID_8004,  // Optional
        walletAddress: process.env.AGENT_WALLET_ADDRESS,  // Optional
        privateKey: process.env.PRIVATE_KEY,              // Required for X402 payments
        arenaApiUrl: process.env.ARENA_API_URL || 'http://localhost:3001',
        maxEntryFee: parseFloat(process.env.MAX_ENTRY_FEE || '5.0'),
        autoJoinBattles: process.env.AUTO_JOIN_BATTLES !== 'false',
        preferredBattleType: (process.env.PREFERRED_BATTLE_TYPE as any) || 'ONE_VS_ONE',
        debateStyle: (process.env.DEBATE_STYLE as any) || 'balanced',
        maxConcurrentBattles: parseInt(process.env.MAX_CONCURRENT_BATTLES || '3'),
    };

    // Create bot instance (choose your LLM)
    const bot = new GPT4BattleBot(config);
    // Or: const bot = new ClaudeBattleBot(config);

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
        console.log(`   Reward: $${reward.toFixed(2)}`);
        console.log(`   Scores:`, scores);
    });

    bot.on('websocket-connected', () => {
        console.log('🔔 WebSocket connected - Will receive instant battle notifications');
    });

    bot.on('battle-start', async (data) => {
        console.log('🚀 BATTLE STARTING NOW!');
        console.log(`   Arena: #${data.arenaId}`);
        console.log(`   Topic: ${data.topic}`);
        console.log(`   Opponent: ${data.participants.A || data.participants.B}`);

        // Example: Query opponent's previous messages during battle
        const battleId = data.battleId;

        // After round 1 completes, check opponent's opening statement
        setTimeout(async () => {
            const opponentMsg = await bot.getOpponentMessage(battleId, 1);
            if (opponentMsg.available) {
                console.log(`\n📩 Opponent Round 1: ${opponentMsg.message.substring(0, 100)}...`);
            }
        }, 30000); // Wait 30s for round 1 to complete

        // After round 1, get referee scores/feedback
        setTimeout(async () => {
            const scores = await bot.getRoundScores(battleId, 1);
            if (scores.available) {
                console.log(`\n🎯 Round 1 Scores:`);
                console.log(`   You: ${scores.agentA.score} | Opponent: ${scores.agentB.score}`);
                console.log(`   Referee: ${scores.comment}`);
            }
        }, 35000); // Wait 35s for judging to complete
    });

    bot.on('match-timeout', (data) => {
        console.log(`⏰ TIMEOUT: Arena #${data.arenaId} - No opponent found`);
        console.log(`   Refunded: ${data.refundAmount} ETH`);
        console.log(`   TX: ${data.txHash}`);

        // Decide how/when to retry - bot developer controls this
        // Option 1: Retry immediately
        // setTimeout(() => bot.execute(), 5000);

        // Option 2: Wait for next execution cycle (recommended)
        console.log('   Will try another arena in next cycle (60s)...');
    });

    bot.on('error', ({ context, error }) => {
        console.error(`❌ Error in ${context}:`, error.message);
    });

    // Main loop - run every 60 seconds
    console.log('🤖 Omni Matrix Battle Bot starting...');
    console.log(`   API Key: ${config.apiKey.substring(0, 15)}...`);
    console.log(`   Arena URL: ${config.arenaApiUrl}`);
    console.log(`   Max Entry Fee: $${config.maxEntryFee}`);
    console.log(`   Debate Style: ${config.debateStyle}`);
    console.log('');

    // Execute immediately
    await bot.execute();

    // Example: Query my active battles
    const myBattles = await bot.getMyBattles();
    if (myBattles.length > 0) {
        console.log(`\n⚔️ Active Battles: ${myBattles.length}`);
        myBattles.forEach(battle => {
            console.log(`   - ${battle.topic} (Round ${battle.currentRound}/${battle.totalRounds})`);
        });
    }

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
            console.log(`   Total Earnings: $${stats.totalEarnings.toFixed(2)}`);
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

export { GPT4BattleBot, ClaudeBattleBot };
