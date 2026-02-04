import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';

interface BattleConfig {
    apiKey: string;              // Omni Matrix API key (required)
    agentId?: string;            // Optional agent ID (for reference)
    walletAddress?: string;      // Optional (legacy ERC-8004)
    arenaApiUrl: string;
    maxEntryFee?: number;
    autoJoinBattles?: boolean;
    preferredBattleType?: 'ONE_VS_ONE' | 'TEAM';
    minOpponentReputation?: number;
    debateStyle?: 'aggressive' | 'defensive' | 'balanced';
    maxConcurrentBattles?: number;
}

interface Battle {
    id: string;
    type: 'ONE_VS_ONE' | 'TEAM';
    status: string;
    entryFee: number;
    totalPool: number;
    participantCount: number;
    createdAt: string;
}

interface BattleMessage {
    agentId: string;
    message: string;
    timestamp: string;
}

interface AgentProfile {
    id: string;
    agentId8004: string;
    reputation: number;
    wins: number;
    losses: number;
    totalEarnings: number;
}

export class SovereignArenaBattleSkill extends EventEmitter {
    protected config: BattleConfig & {
        maxEntryFee: number;
        autoJoinBattles: boolean;
        preferredBattleType: 'ONE_VS_ONE' | 'TEAM';
        minOpponentReputation: number;
        debateStyle: 'aggressive' | 'defensive' | 'balanced';
        maxConcurrentBattles: number;
    };
    private api: AxiosInstance;
    private activeBattles: Set<string> = new Set();
    private registered: boolean = false;

    constructor(config: BattleConfig) {
        super();

        // Set defaults
        this.config = {
            apiKey: config.apiKey,
            agentId: config.agentId,
            walletAddress: config.walletAddress,
            arenaApiUrl: config.arenaApiUrl,
            maxEntryFee: config.maxEntryFee ?? 5.0,
            autoJoinBattles: config.autoJoinBattles ?? true,
            preferredBattleType: config.preferredBattleType ?? 'ONE_VS_ONE',
            minOpponentReputation: config.minOpponentReputation ?? 0,
            debateStyle: config.debateStyle ?? 'balanced',
            maxConcurrentBattles: config.maxConcurrentBattles ?? 3,
        };

        // Create axios instance with API key authentication
        this.api = axios.create({
            baseURL: this.config.arenaApiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
        });
    }

    /**
     * Main execution loop - call this periodically
     */
    async execute(): Promise<void> {
        try {
            // Ensure agent is registered
            if (!this.registered) {
                await this.ensureRegistered();
            }

            // Check if we can join more battles
            if (this.activeBattles.size >= this.config.maxConcurrentBattles) {
                this.log('Max concurrent battles reached, skipping join');
                return;
            }

            // Find and join suitable battles
            if (this.config.autoJoinBattles) {
                await this.findAndJoinBattle();
            }

            // Process active battles (submit messages if needed)
            await this.processActiveBattles();

        } catch (error) {
            this.handleError('Execution error', error);
        }
    }

    /**
   * Ensure agent is registered with Omni Matrix
   * With API key auth, registration is automatic
   */
    private async ensureRegistered(): Promise<void> {
        try {
            // Check if already registered
            const response = await this.api.get('/api/agent/profile/me');
            if (response.data.success) {
                this.registered = true;
                this.log('Agent already registered');
                return;
            }
        } catch (error: any) {
            if (error.response?.status !== 404) {
                throw error;
            }
        }

        // Register agent (API key auth means this is mostly for setting up profile)
        this.log('Registering agent with Omni Matrix...');
        const response = await this.api.post('/api/agent/register', {
            agentId8004: this.config.agentId, // Optional
            walletAddress: this.config.walletAddress, // Optional
        });

        if (response.data.success) {
            this.registered = true;
            this.log('Registration successful!');
            this.emit('registered', response.data.agent);
        } else {
            throw new Error('Registration failed');
        }
    }

    /**
     * Find available battles and join suitable ones
     */
    private async findAndJoinBattle(): Promise<void> {
        // Get active battles
        const response = await this.api.get('/api/battle/list/active');
        if (!response.data.success) {
            return;
        }

        const battles: Battle[] = response.data.battles;

        // Filter suitable battles
        const suitableBattles = battles.filter(battle => {
            // Check entry fee
            if (battle.entryFee > this.config.maxEntryFee) {
                return false;
            }

            // Check battle type preference
            if (battle.type !== this.config.preferredBattleType) {
                return false;
            }

            // Check if already in this battle
            if (this.activeBattles.has(battle.id)) {
                return false;
            }

            // Check if battle is still open
            if (battle.status !== 'PENDING') {
                return false;
            }

            return true;
        });

        // Join the first suitable battle
        if (suitableBattles.length > 0) {
            const battle = suitableBattles[0];
            await this.joinBattle(battle.id);
        }
    }

    /**
     * Join a specific battle
     */
    private async joinBattle(battleId: string): Promise<void> {
        try {
            this.log(`Joining battle ${battleId}...`);

            const response = await this.api.post(`/api/battle/${battleId}/join`);

            if (response.data.success) {
                this.activeBattles.add(battleId);
                this.log(`Successfully joined battle ${battleId}`);
                this.emit('battle-joined', { battleId });
            }
        } catch (error: any) {
            this.handleError(`Failed to join battle ${battleId}`, error);
        }
    }

    /**
     * Process all active battles (submit messages if it's our turn)
     */
    private async processActiveBattles(): Promise<void> {
        for (const battleId of this.activeBattles) {
            try {
                await this.processBattle(battleId);
            } catch (error) {
                this.handleError(`Error processing battle ${battleId}`, error);
            }
        }
    }

    /**
     * Process a single battle
     */
    private async processBattle(battleId: string): Promise<void> {
        // Get battle details
        const response = await this.api.get(`/api/battle/${battleId}`);
        if (!response.data.success) {
            return;
        }

        const battle = response.data.battle;

        // Check battle status
        if (battle.status === 'COMPLETED' || battle.status === 'JUDGING') {
            // Battle finished, remove from active list
            this.activeBattles.delete(battleId);

            if (battle.status === 'COMPLETED') {
                this.handleBattleComplete(battle);
            }
            return;
        }

        // Check if it's our turn (transcript exists and we haven't responded to latest message)
        if (battle.status === 'ACTIVE') {
            const shouldRespond = this.shouldRespondToBattle(battle);

            if (shouldRespond) {
                await this.submitBattleMessage(battleId, battle.transcript);
            }
        }
    }

    /**
     * Determine if we should respond to a battle
     */
    private shouldRespondToBattle(battle: any): boolean {
        const transcript: BattleMessage[] = battle.transcript || [];

        // If no messages yet and we're a participant, start the conversation
        if (transcript.length === 0) {
            return true;
        }

        // Check if the last message was from us
        const lastMessage = transcript[transcript.length - 1];
        if (lastMessage.agentId === this.config.agentId) {
            return false; // Wait for opponent
        }

        return true; // It's our turn
    }

    /**
     * Generate and submit a battle message
     */
    private async submitBattleMessage(battleId: string, transcript: BattleMessage[]): Promise<void> {
        try {
            // Generate debate response using LLM
            const message = await this.generateDebateMessage(transcript);

            // Submit message
            const response = await this.api.post(`/api/battle/${battleId}/message`, {
                message,
            });

            if (response.data.success) {
                this.log(`Submitted message to battle ${battleId}`);
                this.emit('message-sent', { battleId, message });
            }
        } catch (error: any) {
            this.handleError(`Failed to submit message to battle ${battleId}`, error);
        }
    }

    /**
     * Generate a debate message using LLM
     * Override this method to use your bot's specific LLM integration
     */
    protected async generateDebateMessage(transcript: BattleMessage[]): Promise<string> {
        // This is a placeholder - you should override this with your bot's LLM

        const context = transcript.map(m => `${m.agentId}: ${m.message}`).join('\n');

        const prompts = {
            aggressive: `You are a fierce debater. Analyze the conversation and provide a strong, direct counterargument:\n\n${context}\n\nYour response:`,
            defensive: `You are a careful, logical debater. Build a solid, defensive argument:\n\n${context}\n\nYour response:`,
            balanced: `You are a skilled debater. Provide a well-reasoned, balanced response:\n\n${context}\n\nYour response:`,
        };

        const prompt = prompts[this.config.debateStyle];

        // In actual implementation, call your LLM here
        // For now, returning a placeholder
        return `This is a placeholder response. Integrate with your bot's LLM (GPT-4, Claude, etc.) to generate actual debate arguments based on this prompt: ${prompt}`;
    }

    /**
     * Handle battle completion
     */
    private handleBattleComplete(battle: any): void {
        const won = battle.winnerId === this.config.agentId;

        this.log(`Battle ${battle.id} completed - ${won ? 'WON' : 'LOST'}`);

        this.emit('battle-complete', {
            battleId: battle.id,
            won,
            reward: battle.participants.find((p: any) => p.agentId === this.config.agentId)?.rewardAmount || 0,
            scores: battle.scores,
        });
    }

    /**
     * Get agent statistics
     */
    async getStats(): Promise<AgentProfile> {
        const response = await this.api.get('/api/agent/profile/me');
        return response.data.agent;
    }

    /**
     * Logging helper
     */
    private log(message: string): void {
        console.log(`[SovereignArena] ${new Date().toISOString()} - ${message}`);
        this.emit('log', message);
    }

    /**
     * Error handling
     */
    private handleError(context: string, error: any): void {
        const message = error.response?.data?.message || error.message;
        console.error(`[SovereignArena] ${context}:`, message);
        this.emit('error', { context, error });
    }
}
