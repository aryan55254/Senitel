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
import * as net from 'net';
import { Socket } from 'net';
import { ConnectionPool } from './ConnectionPool';
import { readFileSync } from 'fs';
import { TLSSocket } from 'tls';
import { ProtocolDecoder } from '../protocol/protocol_decoder';
import { BackendMessageCode } from '../protocol/pg_wire_message_types';
import { ProtocolEncoder } from '../protocol/protocol_encoder';
import { Sentinel } from '../../senitel/Sentinel';

class ProxySession {
    private backendSocket: Socket | null = null;
    private readonly remoteAddr: string;
    private activeRequests = 0;
    private targetPool: ConnectionPool | undefined;
    private clientdecoder = new ProtocolDecoder('frontend');
    private sharddecoder = new ProtocolDecoder('backend');
    private isFrontendPipingSetup = false;
    private sentinel!: Sentinel;

    constructor(
        private clientSocket: Socket,
        private readonly pools: Map<string, ConnectionPool>,
        rateLimitConfig: { rateLimitCapacity: number; rateLimitPerSec: number }
    ) {
        this.remoteAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
        this.sentinel = new Sentinel(rateLimitConfig);
        this.initialize();
    }

    // INITIALIZATION 

    private initialize() {
        this.clientSocket.pause();
        this.setupLifecycleHooks();
        this.clientSocket.resume();
    }

    private setupLifecycleHooks() {
        this.clientSocket.once('data', (chunk: Buffer) => {
            if (chunk.length === 8 && chunk.readInt32BE(0) === 8 && chunk.readInt32BE(4) === 80877103) {
                this.handleSSLrequest(this.clientSocket);
            } else {
                this.clientSocket.pause();
                this.clientSocket.unshift(chunk);
                this.setupfrontenddecodepiping(this.clientSocket);
                this.clientSocket.resume();
            }
        });

        this.clientSocket.on('close', () => {
            console.log(`[${this.remoteAddr}] Client disconnected`);
            if (this.backendSocket && this.targetPool) {
                this.targetPool.release(this.backendSocket);
                this.activeRequests--;
            }
            this.sentinel.evict(this.remoteAddr);
        });

        this.clientSocket.on('error', () => {
            this.clientSocket.destroy();
        });
    }

    // HANDSHAKE / AUTH 
    private handleSSLrequest(socket: Socket) {
        socket.write('S');

        // remove the data listeners so that no data that is sent during the transition causes a hang 
        socket.removeAllListeners('data');
        const secureSocket = new TLSSocket(socket, {
            isServer: true,
            key: readFileSync('server-key.pem'),
            cert: readFileSync('server-cert.pem'),
            requestCert: false,
        });

        secureSocket.on('secure', () => {
            console.log(`[${this.remoteAddr}] TLS tunnel established`);
            this.clientSocket = secureSocket;
            this.setupfrontenddecodepiping(this.clientSocket);
        });

        secureSocket.on('error', (err) => {
            console.error(`[${this.remoteAddr}] TLS Error:`, err);
            this.clientSocket.destroy();
        });
    }

    // CONNECTION ACQUISITION 

    private async acquireandpipe() {
        // Grab the first available pool (e.g. 'instance_01')
        const firstAvailablePoolId = Array.from(this.pools.keys())[0];
        this.targetPool = this.pools.get(firstAvailablePoolId);

        if (!this.targetPool) {
            console.error('[Sentinel] Shard pool not found for ID:', firstAvailablePoolId);
            this.clientSocket.destroy();
            return;
        }

        try {
            this.clientSocket.pause();
            const socket = await this.targetPool.acquire();
            this.backendSocket = socket;
            this.activeRequests++;

            console.log(`[${this.remoteAddr}] Acquired shard socket from pool`);

            this.setupfrontenddecodepiping(this.clientSocket);
            this.clientSocket.resume();
            this.setupbackenddecodepiping(this.backendSocket, this.clientSocket);
        } catch (err) {
            console.error('[Sentinel] Failed to acquire socket:', err);
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
                if (msg.type === 0x00) {
                    // StartupMessage - fake login
                    const authOk = ProtocolEncoder.encode(BackendMessageCode.AuthenticationResponse, Buffer.from([0, 0, 0, 0]));
                    const readyForQuery = ProtocolEncoder.encode(BackendMessageCode.ReadyForQuery, Buffer.from('I'));

                    this.clientSocket.write(authOk);

                    const params = [
                        ['server_version', '16.0'],
                        ['client_encoding', 'UTF8'],
                        ['standard_conforming_strings', 'on']
                    ];
                    for (const [k, v] of params) {
                        const payload = Buffer.concat([Buffer.from(k + '\0'), Buffer.from(v + '\0')]);
                        this.clientSocket.write(ProtocolEncoder.encode(BackendMessageCode.ParameterStatus, payload));
                    }

                    const backendKeyData = Buffer.alloc(8);
                    backendKeyData.writeUInt32BE(1234, 0);
                    backendKeyData.writeUInt32BE(5678, 4);
                    this.clientSocket.write(ProtocolEncoder.encode(BackendMessageCode.BackendKeyData, backendKeyData));

                    this.clientSocket.write(readyForQuery);
                    continue;
                }

                if (!this.backendSocket) {
                    await this.acquireandpipe();
                }

                // SENTINEL 
                const verdict = this.sentinel.inspect(msg, this.remoteAddr);
                if (!verdict.allowed) {
                    this.clientSocket.write(verdict.errorFrame!);
                    continue;
                }
                // ─────────────────────────────────────────────────────────

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
                        console.log(`[${this.remoteAddr}] Shard idle — releasing to pool`);
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