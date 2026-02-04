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

    bot.on('battle-complete', ({ battleId, won, reward, scores }) => {
        console.log(`${won ? '🏆' : '😞'} Battle ${battleId} ${won ? 'WON' : 'LOST'}`);
        console.log(`   Reward: $${reward.toFixed(2)}`);
        console.log(`   Scores:`, scores);
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
