/**
 * Client Resource Manager
 *
 * Connects shard connections to client connections.
 * Handles backpressure via memory guard, multiplexed connection pooling,
 * and PG wire auth via SSL.
 *
 * Sentinel is wired in at the message loop — every Query (Q) message
 * is inspected before being forwarded to the shard.
 */
import net, { Socket } from 'net';
import { ShardConnectionPool } from './ConnectionPool';
import { readFileSync } from 'fs';
import { TLSSocket } from 'tls';
import { ProtocolDecoder } from '../protocol/protocol_decoder';
import { BackendMessageCode } from '../protocol/pg_wire_message_types';
import { Sentinel } from '../../sentinel/Sentinel';

class ProxySession {
    private backendSocket: net.Socket | null = null;
    private readonly remoteAddr: string;
    private activeRequests = 0;
    private targetPool: ShardConnectionPool | undefined;
    private clientdecoder = new ProtocolDecoder('frontend');
    private sharddecoder = new ProtocolDecoder('backend');
    private isFrontendPipingSetup = false;
    private sentinel = new Sentinel({ rateLimitCapacity: 20, rateLimitPerSec: 10 });

    constructor(
        private clientSocket: Socket,
        private readonly shardPools: Map<string, ShardConnectionPool>
    ) {
        this.remoteAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
        this.initialize();
    }

    // INITIALIZATION

    private initialize() {
        console.log(`[${this.remoteAddr}] Client session initiated`);
        this.clientSocket.pause();
        this.setupLifecycleHooks();
    }

    private setupLifecycleHooks() {
        this.clientSocket.once('data', (chunk) => {
            if (chunk.length === 8 && chunk.readInt32BE(0) === 8 && chunk.readInt32BE(4) === 80877103) {
                this.handleSSLrequest(this.clientSocket);
            } else {
                this.clientSocket.pause();
                this.clientSocket.unshift(chunk);
                this.acquireandpipe();
            }
        });

        this.clientSocket.on('close', () => {
            console.log(`[${this.remoteAddr}] Client disconnected`);
            if (this.backendSocket && this.targetPool) {
                this.targetPool.release(this.backendSocket);
                this.activeRequests--;
            }
            // Evict rate-limit bucket for this client to free memory
            this.sentinel.evict(this.remoteAddr);
        });

        this.clientSocket.on('error', () => {
            this.clientSocket.destroy();
        });
    }

    // HANDSHAKE / AUTH 

    private handleSSLrequest(socket: Socket) {
        socket.write('S');
        const secureSocket = new TLSSocket(socket, {
            isServer: true,
            key: readFileSync('server-key.pem'),
            cert: readFileSync('server-cert.pem'),
            requestCert: true,
        });

        secureSocket.on('secureConnect', () => {
            console.log('TLS Tunnel Established!');
            this.clientSocket = secureSocket;
            this.setupfrontenddecodepiping(this.clientSocket);
            this.acquireandpipe();
        });
    }

    // CONNECTION ACQUISITION

    private async acquireandpipe() {
        this.targetPool = this.shardPools.get('shard_01');

        if (!this.targetPool) {
            console.error('Shard pool not found!');
            this.clientSocket.destroy();
            return;
        }

        try {
            this.clientSocket.pause();
            const socket = await this.targetPool.acquire();
            this.backendSocket = socket;
            this.activeRequests++;

            console.log(`[${this.remoteAddr}] Acquired backend socket from pool`);

            this.setupfrontenddecodepiping(this.clientSocket);
            this.clientSocket.resume();
            this.setupbackenddecodepiping(this.backendSocket, this.clientSocket);
        } catch (err) {
            console.error('Failed to acquire socket:', err);
            this.clientSocket.destroy();
        }
    }

    // DATA PIPING & DECODING 

    private setupfrontenddecodepiping(clientSocket: Socket) {
        if (this.isFrontendPipingSetup) return;
        this.isFrontendPipingSetup = true;

        this.clientSocket.on('data', async (chunk: Buffer) => {
            const messages = this.clientdecoder.parse(chunk);

            for (const msg of messages) {
                if (!this.backendSocket) {
                    await this.acquireandpipe();
                }

                // SENTINEL 
                const verdict = this.sentinel.inspect(msg, this.remoteAddr);
                if (!verdict.allowed) {
                    this.clientSocket.write(verdict.errorFrame!);
                    continue;
                }

                const flushed = this.backendSocket?.write(msg.raw);
                if (!flushed) {
                    this.clientSocket.pause();
                    this.backendSocket?.once('drain', () => this.clientSocket.resume());
                }
            }
        });
    }

    private async setupbackenddecodepiping(backendSocket: Socket, clientSocket: Socket) {
        this.backendSocket?.on('data', (chunk: Buffer) => {
            const messages = this.sharddecoder.parse(chunk);

            for (const msg of messages) {
                const flushed = this.clientSocket?.write(msg.raw);
                if (!flushed) {
                    this.clientSocket.pause();
                    this.backendSocket?.once('drain', () => this.clientSocket.resume());
                }

                // MULTIPLEXING TRIGGER
                if (msg.type === BackendMessageCode.ReadyForQuery) {
                    const status = msg.payload[0];
                    if (status === 73) {
                        console.log(`[${this.remoteAddr}] Shard Idle. Releasing to pool.`);
                        this.detachBackend();
                    }
                }
            }
        });
    }

    // CLEANUP & POOL RELEASE

    private detachBackend() {
        if (this.backendSocket && this.targetPool) {
            this.backendSocket.removeAllListeners('data');
            this.backendSocket.removeAllListeners('drain');
            this.targetPool.release(this.backendSocket);
            this.backendSocket = null;
        }
    }
}

export default ProxySession;