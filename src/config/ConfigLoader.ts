/**
 * ConfigLoader
 * Reads sentinel.config.json from the project root.
 * Validates structure and returns a typed config object.
 * All network and rate limit config lives here — nothing is hardcoded.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface InstanceConfig {
    id: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    database?: string;
}

export interface SentinelConfig {
    sentinel: {
        port: number;
    };
    rateLimit: {
        capacity: number;
        refillPerSec: number;
    };
    instances: InstanceConfig[];
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
    if (!config.instances?.length) throw new Error('[Sentinel] Config missing instances');
    for (const i of config.instances) {
        if (!i.id || !i.host || !i.port) {
            throw new Error(`[Sentinel] Invalid instance entry: ${JSON.stringify(i)}`);
        }
        if (!i.user || !i.password || !i.database) {
            throw new Error(`[Sentinel] Missing auth details (user/password/database) for instance ${i.id}`);
        }
    }
}