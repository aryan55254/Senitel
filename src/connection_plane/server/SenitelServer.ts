/**
 * SentinelServer
 *
 * Entry point and orchestrator for the Sentinel query firewall.
 * Reads config from sentinel.config.json, initializes a warm connection
 * pool for each configured Postgres instance, then accepts incoming client
 * connections and hands them off to ProxySession.
 */
import * as net from 'net';
import { Socket } from 'net';
import ProxySession from './ClientsConnections';
import { ConnectionPool } from './ConnectionPool';
import { loadConfig } from '../../config/ConfigLoader';

const config = loadConfig();

class SentinelServer {
    private pools: Map<string, ConnectionPool> = new Map();
    private server: net.Server;

    constructor() {
        this.initializePools();
        this.server = net.createServer((socket: Socket) => this.handleConnection(socket));
    }

    private initializePools() {
        for (const instance of config.instances) {
            this.pools.set(instance.id, new ConnectionPool(instance));
            console.log(`[Sentinel] Pool initialized → ${instance.id} at ${instance.host}:${instance.port}`);
        }
    }

    private handleConnection(clientSocket: Socket) {
        new ProxySession(clientSocket, this.pools);
    }

    public start() {
        this.server.listen(config.sentinel.port, () => {
            console.log(`[Sentinel] Listening on port ${config.sentinel.port}`);
            console.log(`[Sentinel] Guarding ${config.instances.length} instance(s)`);
        });
    }
}

const server = new SentinelServer();
server.start();