/**
 * ConnectionPool
 * 
 * Maintains a fixed pool of warm, authenticated SSL connections to a single
 * backend Postgres database instance.
 * 
 * - Always keeps exactly 10 live connections open (self-healing on socket error)
 * - Multiplexes connections across clients via acquire() / release()
 * - Queues callers when all connections are in use, unblocking them FIFO
 *   as connections are returned
 * - Handles PG wire SSL negotiation on each connection at startup
 */
import { Socket } from 'net';
import { readFileSync } from 'fs';
import { TLSSocket } from 'tls';
import { authenticateBackend } from '../auth/PgAuth';
import { InstanceConfig } from '../../config/ConfigLoader';

export class ConnectionPool {
    private connections: Socket[] = [];
    private availableConnections: Socket[] = [];
    private requestQueue: ((socket: Socket) => void)[] = [];

    constructor(private config: InstanceConfig) {
        this.initializePool();
    }

    /**
     * Performs SSL negotiation with the backend using the PG wire protocol.
     * Sends the SSLRequest magic bytes, waits for 'S' (accepted), then
     * upgrades the raw TCP socket to a TLS tunnel.
     */
    private sslHandshake(socket: Socket) {
        console.log(`[ConnectionPool] Starting SSL Handshake for ${this.config.id}`);
        const buf = Buffer.from('0000000804d2162f', 'hex');
        socket.write(buf);
        socket.once('data', (chunk: Buffer) => {
            console.log(`[ConnectionPool] SSL Handshake response for ${this.config.id}: ${chunk[0].toString(16)}`);
            if (chunk[0] === 0x53) {
                const secureSocket = new TLSSocket(socket, {
                    isServer: false,
                    ca: [readFileSync('server-cert.pem')],
                });
                secureSocket.on('secureConnect', async () => {
                    console.log(`[ConnectionPool] TLS tunnel established for ${this.config.id}`);
                    try {
                        console.log(`[ConnectionPool] Authenticating backend for ${this.config.id}...`);
                        await authenticateBackend(secureSocket, this.config.user!, this.config.password!, this.config.database!);
                        console.log(`[ConnectionPool] Authenticated backend for ${this.config.id} successfully!`);
                        this.connections.push(secureSocket);
                        this.release(secureSocket);
                    } catch (err) {
                        console.error(`[ConnectionPool] Auth failed for ${this.config.id}:`, err);
                        this.handleDeadSocket(secureSocket);
                    }
                });
                secureSocket.on('error', (err) => {
                    console.error(`[ConnectionPool] TLS Error for ${this.config.id}:`, err.message);
                    this.handleDeadSocket(secureSocket);
                });
                socket.on('close', () => this.handleDeadSocket(socket));
            } else if (chunk[0] === 0x4e) {
                console.error(`[ConnectionPool] Backend ${this.config.id} does NOT support SSL! (Sent N)`);
                this.handleDeadSocket(socket);
            }
        });
    }

    private addSocket() {
        const socket = new Socket();
        socket.on('connect', () => this.sslHandshake(socket));
        socket.connect(this.config.port, this.config.host);
    }

    /**
     * Removes a dead socket from all tracking structures and opens
     * a replacement to maintain the pool size invariant.
     */
    private handleDeadSocket(socket: Socket) {
        this.connections = this.connections.filter(s => s !== socket);
        this.availableConnections = this.availableConnections.filter(s => s !== socket);
        socket.destroy();

        // Prevent infinite fast reconnect loop spam by delaying reconnect
        setTimeout(() => {
            if (this.connections.length < 10) {
                this.addSocket();
            }
        }, 3000);
    }

    private initializePool() {
        for (let i = 0; i < 10; i++) {
            this.addSocket();
        }
    }

    /**
     * Borrows a connection from the pool.
     * If none are available, the caller is suspended until one is returned.
     */
    public async acquire(): Promise<Socket> {
        console.log(`[ConnectionPool] Acquire requested. Available: ${this.availableConnections.length}, Queued: ${this.requestQueue.length}`);
        if (this.availableConnections.length > 0) {
            console.log(`[ConnectionPool] Handing over available connection directly.`);
            return this.availableConnections.pop()!;
        }
        console.log(`[ConnectionPool] No available connections. Queuing request.`);
        return new Promise((resolve) => this.requestQueue.push(resolve));
    }

    /**
     * Returns a connection to the pool.
     * If callers are queued, the connection is handed directly to the next one.
     */
    public async release(socket: Socket) {
        console.log(`[ConnectionPool] Socket released back to pool.`);
        if (this.requestQueue.length > 0) {
            console.log(`[ConnectionPool] Handing released socket directly to queued caller.`);
            const next = this.requestQueue.shift()!;
            next(socket);
        } else {
            console.log(`[ConnectionPool] Returning socket to available pool.`);
            this.availableConnections.push(socket);
        }
    }
}