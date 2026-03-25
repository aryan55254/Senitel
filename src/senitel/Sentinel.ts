/**
 * Sentinel — Query Firewall for Conduit
 *
 * Sits between the Protocol Decoder and the backend shard socket.
 * For every incoming Query (Q) message it:
 *   1. Inspects SQL text via QueryGuard
 *   2. Logs the decision via SentinelLogger
 *
 * Returns:
 *   { allowed: true }                      = forward to shard as normal
 *   { allowed: false, errorFrame: Buffer } = write errorFrame to client, drop query
 */
import { FrontendMessageCode } from '../connection_plane/protocol/pg_wire_message_types';
import { DecodedMessage } from '../connection_plane/protocol/protocol_decoder';
import { ProtocolEncoder } from '../connection_plane/protocol/protocol_encoder';
import { QueryGuard } from './QueryGuard';
import { SentinelLogger } from './SentinelLogger';

export interface SentinelVerdict {
  allowed: boolean;
  errorFrame?: Buffer;
}

export interface SentinelConfig { }

const DEFAULT_CONFIG: SentinelConfig = {};

export class Sentinel {
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

  public evict(clientAddr: string) { }
}