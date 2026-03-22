/**
 * ConfigLoader
 * Reads sentinel.config.json from the project root.
 * Validates structure and returns a typed config object.
 * All network and rate limit config lives here — nothing is hardcoded.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface ShardConfig {
    id: string;
    host: string;
    port: number;
}

export interface SentinelConfig {
    sentinel: {
        port: number;
    };
    rateLimit: {
        capacity: number;
        refillPerSec: number;
    };
    shards: ShardConfig[];
}

export function loadConfig(path: string = 'sentinel.config.json'): SentinelConfig {
    const raw = readFileSync(resolve(process.cwd(), path), 'utf-8');
    const config = JSON.parse(raw) as SentinelConfig;
    validate(config);
    return config;
}

function validate(config: SentinelConfig) {
    if (!config.sentinel?.port) throw new Error('[Sentinel] Config missing sentinel.port');
    if (!config.rateLimit?.capacity) throw new Error('[Sentinel] Config missing rateLimit.capacity');
    if (!config.rateLimit?.refillPerSec) throw new Error('[Sentinel] Config missing rateLimit.refillPerSec');
    if (!config.shards?.length) throw new Error('[Sentinel] Config missing shards');
    for (const s of config.shards) {
        if (!s.id || !s.host || !s.port) {
            throw new Error(`[Sentinel] Invalid shard entry: ${JSON.stringify(s)}`);
        }
    }
}