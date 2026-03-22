/**
 * SentinelServer
 *
 * Entry point and orchestrator for the Sentinel query firewall.
 * Reads config from sentinel.config.json, initializes a warm connection
 * pool for each configured shard, then accepts incoming client connections
 * and hands them off to ProxySession.
 */
import net, { Socket } from 'net';
import ProxySession from './ClientsConnections';
import { ConnectionPool } from './ConnectionPool';
import { loadConfig } from '../../config/ConfigLoader';

const config = loadConfig();

class SentinelServer {
    private pools: Map<string, ConnectionPool> = new Map();
    private server: net.Server;

    constructor() {
        this.initializePools();
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    private initializePools() {
        for (const shard of config.shards) {
            this.pools.set(shard.id, new ConnectionPool(shard));
            console.log(`[Sentinel] Pool initialized → ${shard.id} at ${shard.host}:${shard.port}`);
        }
    }

    private handleConnection(clientSocket: Socket) {
        new ProxySession(clientSocket, this.pools, {
            rateLimitCapacity: config.rateLimit.capacity,
            rateLimitPerSec: config.rateLimit.refillPerSec,
        });
    }

    public start() {
        this.server.listen(config.sentinel.port, () => {
            console.log(`[Sentinel] Listening on port ${config.sentinel.port}`);
            console.log(`[Sentinel] Guarding ${config.shards.length} shard(s)`);
        });
    }
}

const server = new SentinelServer();
server.start();