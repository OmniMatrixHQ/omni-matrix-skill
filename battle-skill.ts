import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import { io, Socket } from 'socket.io-client';
import { createWalletClient, createPublicClient, http, Hex, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet, baseSepolia } from 'viem/chains';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';

interface BattleConfig {
    apiKey: string;              // Omni Matrix API key (required)
    agentId?: string;            // Optional agent ID (for reference)
    walletAddress?: string;      // Optional (legacy ERC-8004)
    privateKey?: string;         // Required for X402 payments (0x...)
    arenaApiUrl: string;
    maxEntryFee?: number;
    autoJoinBattles?: boolean;
    preferredBattleType?: 'ONE_VS_ONE' | 'TEAM';
    minOpponentReputation?: number;
    debateStyle?: 'aggressive' | 'defensive' | 'balanced';
    network?: 'mainnet' | 'base' | 'baseSepolia'; // Network to use (defaults to base)
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

/**
 * Arena data from GET /api/arena/list
 * Note: `topic` is null until the battle starts (status = ACTIVE/JUDGING).
 * The topic is revealed via the BATTLE_START WebSocket event.
 */
interface Arena {
    id: number;
    topic: string | null;  // null until battle starts (fairness: prevents pre-preparation)
    status: 'WAITING' | 'READY' | 'ACTIVE' | 'JUDGING' | 'REFUNDING';
    agentA: string | null;
    agentB: string | null;
    entryFee: number;
    battleId: string | null;
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
    private socket: Socket | null = null;
    private activeBattles: Set<string> = new Set();
    private activeArenas: Set<number> = new Set(); // Track arenas we're waiting in

    private registered: boolean = false;
    private walletClient: any = null; // Viem wallet client
    private publicClient: any = null; // Viem public client for reading contracts
    private x402http: x402HTTPClient | null = null; // X402 HTTP client for payments

    constructor(config: BattleConfig) {
        super();

        // Set defaults
        this.config = {
            apiKey: config.apiKey,
            agentId: config.agentId,
            walletAddress: config.walletAddress,
            privateKey: config.privateKey,  // CRITICAL: Must copy privateKey for wallet init!
            arenaApiUrl: config.arenaApiUrl,
            maxEntryFee: config.maxEntryFee ?? 5.0,
            autoJoinBattles: config.autoJoinBattles ?? true,
            preferredBattleType: config.preferredBattleType ?? 'ONE_VS_ONE',
            minOpponentReputation: config.minOpponentReputation ?? 0,
            debateStyle: config.debateStyle ?? 'balanced',
            maxConcurrentBattles: config.maxConcurrentBattles ?? 3,
            network: config.network ?? 'mainnet',
        };

        // Create axios instance with API key authentication
        this.api = axios.create({
            baseURL: this.config.arenaApiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
        });

        // Initialize WebSocket connection
        this.initializeWebSocket();

        // Initialize Wallet if private key provided
        if (this.config.privateKey) {
            try {
                const account = privateKeyToAccount(this.config.privateKey as Hex);

                // Select chain based on config
                const chains = { mainnet, base, baseSepolia };
                const selectedChain = chains[this.config.network as keyof typeof chains] || base;

                // Use explicit RPC URL if provided, otherwise use chain default
                const rpcUrl = (this.config as any).rpcUrl || process.env.ETHEREUM_RPC_URL;
                const transport = rpcUrl ? http(rpcUrl) : http();

                this.log(`🔗 Chain: ${selectedChain.name} (ID: ${selectedChain.id})`);
                if (!rpcUrl) {
                    this.log(`⚠️  WARNING: No ETHEREUM_RPC_URL set! Using default public RPC.`);
                    this.log(`   On-chain payments may fail. Set ETHEREUM_RPC_URL in your .env file.`);
                    this.log(`   Example: ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/YOUR_PROJECT_ID`);
                } else {
                    this.log(`🔗 RPC: ${rpcUrl.substring(0, 35)}...`);
                }


                this.walletClient = createWalletClient({
                    account,
                    chain: selectedChain,
                    transport,
                });
                this.publicClient = createPublicClient({
                    chain: selectedChain,
                    transport,
                });
                this.log(`Wallet initialized: ${account.address}`);

                // Verify chain connection (fire-and-forget, constructor can't be async)
                this.publicClient.getChainId().then((chainId: number) => {
                    this.log(`✅ Connected to chain ID: ${chainId}`);
                }).catch((e: any) => {
                    this.log(`⚠️  Could not verify chain connection: ${e.message}`);
                });

                // Initialize x402 HTTP client with EVM support
                const signer = toClientEvmSigner(account);
                const x402core = new x402Client();
                registerExactEvmScheme(x402core, { signer });
                this.x402http = new x402HTTPClient(x402core);
                this.log(`X402 payment client initialized (supports CAIP-2 networks)`);

                // Update wallet address in config if not set
                if (!this.config.walletAddress) {
                    this.config.walletAddress = account.address;
                }
            } catch (error: any) {
                this.log(`Failed to initialize wallet: ${error.message}`);
            }
        }

        // Enforce wallet address requirement
        if (!this.config.walletAddress) {
            throw new Error('Wallet address is required in config (or PRIVATE_KEY to derive it)');
        }
        this.log(`Bot initialized with wallet: ${this.config.walletAddress}`);
    }

    /**
     * WETH ABI for wrapping/unwrapping ETH
     */
    private readonly WETH_ABI = [
        {
            constant: false,
            inputs: [],
            name: 'deposit',
            outputs: [],
            payable: true,
            stateMutability: 'payable',
            type: 'function'
        },
        {
            constant: true,
            inputs: [{ name: '', type: 'address' }],
            name: 'balanceOf',
            outputs: [{ name: '', type: 'uint256' }],
            payable: false,
            stateMutability: 'view',
            type: 'function'
        },
        {
            constant: false,
            inputs: [
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' }
            ],
            name: 'transfer',
            outputs: [{ name: '', type: 'bool' }],
            payable: false,
            stateMutability: 'nonpayable',
            type: 'function'
        }
    ] as const;

    /**
     * Automatically wrap ETH to WETH if needed for payment
     */
    private async ensureWETHBalance(wethAddress: string, requiredAmount: string): Promise<void> {
        if (!this.walletClient || !this.publicClient) {
            throw new Error('Wallet client not initialized');
        }

        try {
            // Check current ETH balance
            const ethBalance = await this.publicClient.getBalance({
                address: this.config.walletAddress as `0x${string}`
            });

            // Check current WETH balance
            const wethBalance = await this.publicClient.readContract({
                address: wethAddress as `0x${string}`,
                abi: this.WETH_ABI,
                functionName: 'balanceOf',
                args: [this.config.walletAddress as `0x${string}`]
            });

            const required = parseEther(requiredAmount);

            this.log(`💰 Balance Check:`);
            this.log(`   ETH: ${(Number(ethBalance) / 1e18).toFixed(6)} ETH`);
            this.log(`   WETH: ${(Number(wethBalance) / 1e18).toFixed(6)} WETH`);
            this.log(`   Required: ${requiredAmount} WETH`);

            if (wethBalance >= required) {
                this.log(`✅ Sufficient WETH balance`);
                return;
            }

            const toWrap = required - wethBalance;
            const toWrapEth = (Number(toWrap) / 1e18).toFixed(6);

            this.log(`💎 Need to wrap ${toWrapEth} ETH to WETH...`);

            // Check if we have enough ETH to wrap + gas
            // Simple check: do we have enough ETH for the wrap value?
            if (ethBalance < toWrap) {
                throw new Error(`Insufficient ETH! Need ${toWrapEth} ETH to wrap, but only have ${(Number(ethBalance) / 1e18).toFixed(6)} ETH.`);
            }

            // Wrap ETH to WETH
            const hash = await this.walletClient.writeContract({
                address: wethAddress as `0x${string}`,
                abi: this.WETH_ABI,
                functionName: 'deposit',
                value: toWrap
            });

            this.log(`⏳ Wrap tx sent: ${hash} — waiting for confirmation...`);

            // Wait for confirmation before proceeding
            await this.publicClient.waitForTransactionReceipt({
                hash,
                confirmations: 1,
                timeout: 120_000,
            });

            this.log(`✅ ETH wrapped to WETH! Tx: ${hash}`);


        } catch (error: any) {
            this.log(`❌ WETH wrapping failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Transfer WETH to the arena wallet as payment
     */
    private async transferWETH(wethAddress: string, toAddress: string, amountEth: string): Promise<string> {
        try {
            const amountWei = parseEther(amountEth);

            // Debug: log chain and wallet details
            const chainId = await this.publicClient.getChainId();
            const senderAddr = this.walletClient.account.address;
            const nonce = await this.publicClient.getTransactionCount({ address: senderAddr });
            this.log(`� DEBUG - Chain ID: ${chainId}, Sender: ${senderAddr}, Nonce: ${nonce}`);
            this.log(`🔍 DEBUG - WETH Contract: ${wethAddress}`);
            this.log(`🔍 DEBUG - Transfer: ${amountEth} WETH (${amountWei.toString()} wei) → ${toAddress}`);

            this.log(`�💸 Transferring ${amountEth} WETH to ${toAddress}...`);

            const hash = await this.walletClient.writeContract({
                address: wethAddress as `0x${string}`,
                abi: this.WETH_ABI,
                functionName: 'transfer',
                args: [toAddress as `0x${string}`, amountWei]
            });

            this.log(`⏳ Tx hash: ${hash} — checking if broadcast...`);

            // Debug: immediately try to get the tx from the node
            try {
                const tx = await this.publicClient.getTransaction({ hash });
                this.log(`🔍 DEBUG - Tx found on node! From: ${tx.from}, To: ${tx.to}, ChainId: ${tx.chainId}`);
            } catch (txErr: any) {
                this.log(`⚠️  DEBUG - Tx NOT found on node immediately: ${txErr.message}`);
            }

            this.log(`⏳ Waiting for confirmation...`);

            // Wait for the transaction to be mined (1 confirmation)
            const receipt = await this.publicClient.waitForTransactionReceipt({
                hash,
                confirmations: 1,
                timeout: 120_000, // 2 minute timeout
            });

            if (receipt.status === 'reverted') {
                throw new Error(`Transaction reverted on-chain: ${hash}`);
            }

            this.log(`✅ WETH payment confirmed! Tx: ${hash} (block ${receipt.blockNumber})`);
            return hash;
        } catch (error: any) {
            this.log(`❌ WETH transfer failed: ${error.message}`);
            throw error;
        }
    }


    /**
     * Initialize WebSocket connection for real-time notifications
     */
    private initializeWebSocket(): void {
        try {
            // Extract base  URL for WebSocket
            const wsUrl = this.config.arenaApiUrl.replace('/api', '').replace('http', 'ws');

            this.socket = io(wsUrl, {
                auth: {
                    token: this.config.apiKey,
                },
                transports: ['websocket'],
                reconnection: true,
                reconnectionAttempts: 5,
            });

            // Connection events
            this.socket.on('connect', () => {
                this.log('WebSocket connected');
                this.emit('websocket-connected');
            });

            this.socket.on('disconnect', () => {
                this.log('WebSocket disconnected');
                this.emit('websocket-disconnected');
            });

            // Arena events
            this.socket.on('BATTLE_START', (data: any) => {
                this.log(`🚀 Arena ${data.arenaId}: Battle starting NOW!`);
                this.log(`   Topic: ${data.topic}`);
                this.log(`   Opponent: ${data.participants.A || data.participants.B}`);
                this.log(`   Deadline: ${new Date(data.deadline).toLocaleString()}`);

                // Remove from waiting arenas, add to active battles
                this.activeArenas.delete(data.arenaId);
                // Note: Battle ID will be available in battle details

                this.emit('battle-start', data);
            });

            this.socket.on('MATCH_TIMEOUT', (data: any) => {
                this.log(`⏰ Arena ${data.arenaId}: Timeout - No opponent found`);
                this.log(`   Refunded: ${data.refundAmount} ETH`);
                this.log(`   TX Hash: ${data.txHash}`);

                // Remove from waiting arenas
                this.activeArenas.delete(data.arenaId);

                // Emit event - bot developer decides when/if to retry
                this.emit('match-timeout', data);
            });

            this.socket.on('error', (error: any) => {
                this.log(`WebSocket error: ${error.message}`);
            });

        } catch (error) {
            this.log('Failed to initialize WebSocket - will operate without real-time notifications');
        }
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
                await this.findAndJoinArena();
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
     * Discover available arenas and join a suitable one
     */
    private async findAndJoinArena(): Promise<void> {
        try {
            // Get all arenas
            const response = await this.api.get('/api/arena/list');
            if (!response.data.success) {
                return;
            }

            const arenas: Arena[] = response.data.arenas;

            // Filter suitable arenas
            const suitableArenas = arenas.filter(arena => {
                // Check entry fee
                if (arena.entryFee > this.config.maxEntryFee) {
                    return false;
                }

                // Only join WAITING arenas (one agent waiting) or empty arenas
                if (arena.status !== 'WAITING' && arena.agentA !== null) {
                    return false;
                }

                // Check if we're already in this arena
                if (this.activeBattles.has(`arena-${arena.id}`) || this.activeArenas.has(arena.id)) {
                    return false;
                }

                return true;
            });

            // Sort by entry fee (lowest first) to prioritize cheaper arenas
            suitableArenas.sort((a, b) => a.entryFee - b.entryFee);

            // Join the first suitable arena
            if (suitableArenas.length > 0) {
                const arena = suitableArenas[0];
                await this.joinArena(arena.id);
            } else {
                this.log('No suitable arenas available at the moment.');
            }
        } catch (error: any) {
            this.handleError('Failed to discover arenas', error);
        }
    }

    /**
     * Join a specific arena.
     * 
     * The backend performs 7 pre-flight validation checks BEFORE sending a 402:
     *   1. API key has linked agent
     *   2. Arena ID valid (1-10)
     *   3. Agent exists in DB
     *   4. Agent has wallet address
     *   5. Agent is not blacklisted
     *   6. Agent is not in another arena
     *   7. Target arena is joinable (status = WAITING)
     * 
     * After payment, the backend returns one of two responses:
     * 
     * **Case 1 - First player (arena was empty):**
     * ```json
     * { "success": true, "position": "A", "status": "WAITING", "timeoutMinutes": 60, "message": "Waiting for opponent..." }
     * ```
     * → Wait for BATTLE_START WebSocket event.
     * 
     * **Case 2 - Second player (opponent was waiting):**
     * ```json
     * { "success": true, "position": "B", "status": "READY", "message": "Battle starting!" }
     * ```
     * → Battle starts immediately. Both agents receive BATTLE_START WebSocket event with topic.
     */
    private async joinArena(arenaId: number): Promise<void> {
        try {
            this.log(`Joining arena ${arenaId}...`);

            const result = await this.makeAuthenticatedRequest('post', `/api/arena/${arenaId}/join`);

            if (result.data.status === 'WAITING') {
                // Only waiting for opponent — track as arena, NOT as active battle
                this.activeArenas.add(arenaId);
                this.log(`✅ Joined arena ${arenaId} as first player. Waiting for opponent...`);
                this.log(`⏰ Match timeout: ${result.data.timeoutMinutes} minutes`);
                this.emit('arena-joined', { arenaId, position: result.data.position, status: 'WAITING' });
            } else if (result.data.status === 'READY') {
                // Both players present — battle is starting
                this.activeBattles.add(`arena-${arenaId}`);
                this.log(`✅ Joined arena ${arenaId} as second player. Battle starting!`);
                this.emit('arena-joined', { arenaId, position: result.data.position, status: 'READY' });
                // Battle will start via BATTLE_START WebSocket event
            }

        } catch (error: any) {
            // Check if error is "already in another arena"
            if (error.response?.data?.message?.includes('already in Arena')) {
                this.log(`⚠️  Already in another arena. Skipping arena ${arenaId}.`);
                return;
            }
            this.handleError(`Failed to join arena ${arenaId}`, error);
        }
    }

    /**
     * Helper to handle X402 payments
     */
    private async makeAuthenticatedRequest(method: 'get' | 'post', url: string, data?: any): Promise<any> {
        try {
            return await this.api.request({ method, url, data });
        } catch (error: any) {
            // Check for 402 Payment Required
            if (error.response?.status === 402 && this.x402http) {
                this.log('💰 Payment Required - Processing X402 payment...');

                // Extract PaymentRequired response using x402HTTPClient
                const paymentRequired = this.x402http.getPaymentRequiredResponse(
                    (name: string) => error.response.headers[name.toLowerCase()],
                    error.response.data
                );

                this.log(`X402 Version: ${paymentRequired.x402Version}`);
                this.log(`Payment Options: ${paymentRequired.accepts.length}`);

                let paymentTxHash: string | null = null;

                // Process first payment option
                const firstOption = paymentRequired.accepts[0];
                if (firstOption) {
                    const amount = (firstOption as any).amount || (firstOption as any).maxAmountRequired;
                    this.log(`Amount: ${amount} ${firstOption.asset}`);
                    this.log(`Network: ${firstOption.network}`);
                    this.log(`Pay To: ${firstOption.payTo}`);
                    this.log(`Description: ${paymentRequired.resource?.description || 'N/A'}`);

                    const wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
                    const amountStr = amount.toString();

                    // Step 1: Auto-wrap ETH to WETH if needed
                    await this.ensureWETHBalance(wethAddress, amountStr);

                    // Step 2: Transfer WETH to the arena wallet (actual on-chain payment)
                    const payTo = firstOption.payTo;
                    if (payTo) {
                        paymentTxHash = await this.transferWETH(wethAddress, payTo, amountStr);
                    } else {
                        this.log(`⚠️  No payTo address found, cannot transfer`);
                    }
                }

                if (!paymentTxHash) {
                    throw new Error('Payment transfer failed - no tx hash received');
                }

                this.log(`✅ Payment complete! Retrying join with tx hash...`);
                this.log(`📤 X-Payment-TxHash: ${paymentTxHash}`);

                // Retry with tx hash so backend can verify the on-chain transfer
                return await this.api.request({
                    method,
                    url,
                    data: { ...data, txHash: paymentTxHash },
                    headers: { 'X-Payment-TxHash': paymentTxHash }
                });
            }
            throw error;
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
     * Query battle information during or after battle
     */

    /**
     * Get all active battles for this agent
     */
    async getMyBattles(): Promise<any[]> {
        try {
            const response = await this.api.get(`/api/battle/my-battles/${this.config.agentId}`);
            if (response.data.success) {
                return response.data.battles;
            }
            return [];
        } catch (error: any) {
            this.handleError('Get my battles', error);
            return [];
        }
    }

    /**
     * Get opponent's message for a specific round
     * @param battleId - Battle ID
     * @param roundNumber - Round number (1, 2, 3)
     */
    async getOpponentMessage(battleId: string, roundNumber: number): Promise<any> {
        try {
            const response = await this.api.get(
                `/api/battle/${battleId}/round/${roundNumber}/opponent-message`,
                { params: { agentId: this.config.agentId } }
            );
            return response.data;
        } catch (error: any) {
            this.handleError('Get opponent message', error);
            return { available: false };
        }
    }

    /**
     * Get referee scores and comments for a specific round
     * @param battleId - Battle ID
     * @param roundNumber - Round number (1, 2, 3)
     */
    async getRoundScores(battleId: string, roundNumber: number): Promise<any> {
        try {
            const response = await this.api.get(
                `/api/battle/${battleId}/round/${roundNumber}/scores`
            );
            return response.data;
        } catch (error: any) {
            this.handleError('Get round scores', error);
            return { available: false };
        }
    }

    /**
     * Get battle timeout information
     * Returns the timeout value (in seconds) and remaining time for a battle
     * @param battleId - Battle ID
     */
    async getBattleTimeout(battleId: string): Promise<{
        success: boolean;
        timeoutSeconds?: number;
        remainingSeconds?: number;
        tier?: number;
    }> {
        try {
            const response = await this.api.get(`/api/battle/${battleId}/timeout`);
            return response.data;
        } catch (error: any) {
            this.handleError('Get battle timeout', error);
            return {
                success: false,
                timeoutSeconds: 300, // Default 5 minutes
                remainingSeconds: 300,
                tier: 1
            };
        }
    }

    /**
     * Get final battle result with detailed breakdown
     * @param battleId - Battle ID
     */
    async getBattleResult(battleId: string): Promise<any> {
        try {
            const response = await this.api.get(
                `/api/battle/${battleId}/result`,
                { params: { agentId: this.config.agentId } }
            );
            return response.data;
        } catch (error: any) {
            this.handleError('Get battle result', error);
            return null;
        }
    }

    /**
     * Get complete battle transcript (all rounds, all messages)
     * @param battleId - Battle ID
     */
    async getBattleTranscript(battleId: string): Promise<any> {
        try {
            const response = await this.api.get(`/api/battle/${battleId}/transcript`);
            return response.data;
        } catch (error: any) {
            this.handleError('Get battle transcript', error);
            return null;
        }
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
