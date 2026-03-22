/**
 * SentinelServer
 * 
 * Entry point and orchestrator for the Sentinel query firewall.
 * Initializes a warm connection pool for each configured backend database,
 * then accepts incoming client connections and hands them off to ProxySession.
 * 
 * Each backend in the config gets its own independent pool of persistent
 * connections — clients never wait for a cold connection to be established.
 */
import net, { Socket } from 'net';
import ProxySession from './ClientsConnections';
import { ConnectionPool } from './ConnectionPool';

interface BackendConfig {
    id: string;
    host: string;
    port: number;
}

interface SentinelServerConfig {
    listenPort: number;
    backends: BackendConfig[];
}

class SentinelServer {
    private pools: Map<string, ConnectionPool> = new Map();
    private server: net.Server;

    constructor(private config: SentinelServerConfig) {
        this.initializePools();
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    private initializePools() {
        for (const backend of this.config.backends) {
            this.pools.set(backend.id, new ConnectionPool(backend));
            console.log(`[Sentinel] Initialized pool for ${backend.id} at ${backend.host}:${backend.port}`);
        }
    }

    private handleConnection(clientSocket: Socket) {
        new ProxySession(clientSocket, this.pools);
    }

    public start() {
        this.server.listen(this.config.listenPort, () => {
            console.log(`[Sentinel] Listening on port ${this.config.listenPort}`);
        });
    }
}