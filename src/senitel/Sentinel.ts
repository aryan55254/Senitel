/**
 * Sentinel — Query Firewall for Conduit
 *
 * Sits between the Protocol Decoder and the backend shard socket.
 * For every incoming Query (Q) message it:
 *   1. Checks per-client rate limit via TokenBucket
 *   2. Inspects SQL text via QueryGuard
 *   3. Logs the decision via SentinelLogger
 *
 * Returns:
 *   { allowed: true }                      = forward to shard as normal
 *   { allowed: false, errorFrame: Buffer } = write errorFrame to client, drop query
 */
import { FrontendMessageCode } from '../connection_plane/protocol/pg_wire_message_types';
import { DecodedMessage } from '../connection_plane/protocol/protocol_decoder';
import { ProtocolEncoder } from '../connection_plane/protocol/protocl_encoder';
import { TokenBucket } from './TokenBucket';
import { QueryGuard } from './QueryGuard';
import { SentinelLogger } from './SentinelLogger';

export interface SentinelVerdict {
  allowed: boolean;
  errorFrame?: Buffer;
}

export interface SentinelConfig {
  rateLimitCapacity: number;  // token bucket burst cap  (default: 20)
  rateLimitPerSec: number;    // token refill per second (default: 10)
}

const DEFAULT_CONFIG: SentinelConfig = {
  rateLimitCapacity: 20,
  rateLimitPerSec: 10,
};

export class Sentinel {
  private buckets = new Map<string, TokenBucket>();
  private logger = new SentinelLogger();
  private config: SentinelConfig;

  constructor(config: Partial<SentinelConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calls this for every decoded message from a client.
   * Only Query (Q) messages are inspected — everything else passes through.
   */
  public inspect(msg: DecodedMessage, clientAddr: string): SentinelVerdict {
    if (msg.type !== FrontendMessageCode.Query) {
      return { allowed: true };
    }

    const sql = msg.payload.toString('utf8').replace(/\0/g, '').trim();
    const ts = new Date().toISOString();

    // ── 1. RATE LIMIT ──────────────────────────────────────────────
    const bucket = this.getOrCreateBucket(clientAddr);
    if (!bucket.consume()) {
      const reason = 'Rate limit exceeded';
      this.logger.record({ ts, client: clientAddr, action: 'RATE_LIMITED', reason, query: sql });
      return {
        allowed: false,
        errorFrame: ProtocolEncoder.encodeError(
          `Sentinel: ${reason} — slow down your query rate`,
          'ERROR',
          '53400'
        ),
      };
    }

    // QUERY GUARD
    const guardResult = QueryGuard.inspect(sql);
    if (guardResult) {
      this.logger.record({ ts, client: clientAddr, action: 'BLOCKED', reason: guardResult.reason, query: sql });
      return {
        allowed: false,
        errorFrame: ProtocolEncoder.encodeError(
          `Sentinel: ${guardResult.reason}`,
          'ERROR',
          guardResult.sqlstate
        ),
      };
    }

    // ALLOWED 
    this.logger.record({ ts, client: clientAddr, action: 'ALLOWED', query: sql });
    return { allowed: true };
  }

  public getLog() {
    return this.logger.getLog();
  }

  /** Call on client disconnect to prevent memory leak */
  public evict(clientAddr: string) {
    this.buckets.delete(clientAddr);
  }

  private getOrCreateBucket(clientAddr: string): TokenBucket {
    if (!this.buckets.has(clientAddr)) {
      this.buckets.set(
        clientAddr,
        new TokenBucket(this.config.rateLimitCapacity, this.config.rateLimitPerSec)
      );
    }
    return this.buckets.get(clientAddr)!;
  }
}