import { Socket } from 'net';
import * as crypto from 'crypto';
import { ProtocolEncoder } from '../protocol/protocol_encoder';
import { BackendMessageCode, FrontendMessageCode } from '../protocol/pg_wire_message_types';

export function authenticateBackend(socket: Socket, user: string, password: string, database: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let state = 'STARTUP';
        let clientNonce = crypto.randomBytes(18).toString('base64');
        let serverNonce: string;
        let salt: Buffer;
        let iterations: number;
        let authMessage: string;

        const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
        };

        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };

        const onData = (chunk: Buffer) => {
            let offset = 0;
            while (offset < chunk.length) {
                const type = chunk.readUInt8(offset);
                const length = chunk.readUInt32BE(offset + 1);
                const payload = chunk.subarray(offset + 5, offset + 1 + length); // ← fixed
                offset += 1 + length;                                             // ← fixed

                if (type === BackendMessageCode.AuthenticationResponse) {
                    const authType = payload.readUInt32BE(0);
                    if (authType === 0) {
                        state = 'AUTHENTICATED';
                    } else if (authType === 10) {
                        const mechanisms = payload.toString('utf8', 4).split('\0').filter(m => m.length > 0);
                        if (!mechanisms.includes('SCRAM-SHA-256')) {
                            return onError(new Error(`Unsupported SASL mechanisms: ${mechanisms.join(', ')}`));
                        }

                        const mechBuf = Buffer.from('SCRAM-SHA-256\0');
                        const clientFirstBare = `n=*,r=${clientNonce}`;          // ← fixed
                        const clientFirstMessage = `n,,${clientFirstBare}`;
                        const cfmBuf = Buffer.from(clientFirstMessage);
                        authMessage = clientFirstBare + ',';                      // ← fixed

                        const payloadBuf = Buffer.alloc(mechBuf.length + 4 + cfmBuf.length);
                        mechBuf.copy(payloadBuf, 0);
                        payloadBuf.writeUInt32BE(cfmBuf.length, mechBuf.length);
                        cfmBuf.copy(payloadBuf, mechBuf.length + 4);

                        socket.write(ProtocolEncoder.encode(FrontendMessageCode.Password, payloadBuf));
                        state = 'SASL_INITIAL';
                    } else if (authType === 11) {
                        const serverFirstMessage = payload.toString('utf8', 4);
                        authMessage += serverFirstMessage + ',';                  // ← correct

                        const parts = serverFirstMessage.split(',');
                        for (const part of parts) {
                            if (part.startsWith('r=')) serverNonce = part.substring(2);
                            if (part.startsWith('s=')) salt = Buffer.from(part.substring(2), 'base64');
                            if (part.startsWith('i=')) iterations = parseInt(part.substring(2), 10);
                        }

                        if (!serverNonce!.startsWith(clientNonce)) {
                            return onError(new Error('Invalid server nonce'));
                        }

                        const clientFinalMessageWithoutProof = `c=biws,r=${serverNonce}`;
                        authMessage += clientFinalMessageWithoutProof;

                        const saltedPassword = crypto.pbkdf2Sync(password, salt!, iterations!, 32, 'sha256');
                        const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
                        const storedKey = crypto.createHash('sha256').update(clientKey).digest();
                        const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
                        const clientProof = Buffer.alloc(32);
                        for (let i = 0; i < 32; i++) {
                            clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
                        }

                        const clientFinalMessage = `${clientFinalMessageWithoutProof},p=${clientProof.toString('base64')}`;
                        socket.write(ProtocolEncoder.encode(FrontendMessageCode.Password, Buffer.from(clientFinalMessage)));
                        state = 'SASL_FINAL';
                    } else if (authType === 12) {
                        // server signature verification — optional, skipping for now
                    } else {
                        return onError(new Error(`Unsupported authentication type: ${authType}`));
                    }
                } else if (type === BackendMessageCode.ErrorMessage) {
                    return onError(new Error(`Postgres error: ${payload.toString('utf8')}`));
                } else if (type === BackendMessageCode.ReadyForQuery) {
                    cleanup();
                    resolve();
                    return;
                }
            }
        };

        socket.on('data', onData);
        socket.on('error', onError);

        const kvPairs = [
            ['user', user],
            ['database', database],
            ['client_encoding', 'UTF8']
        ];

        let kvBytes = 0;
        for (const [k, v] of kvPairs) {
            kvBytes += Buffer.byteLength(k) + 1 + Buffer.byteLength(v) + 1;
        }
        kvBytes += 1;

        const length = 4 + 4 + kvBytes;
        const msg = Buffer.alloc(length);
        msg.writeUInt32BE(length, 0);
        msg.writeUInt32BE(196608, 4);

        let offset = 8;
        for (const [k, v] of kvPairs) {
            msg.write(k, offset);
            offset += Buffer.byteLength(k);
            msg.writeUInt8(0, offset++);
            msg.write(v, offset);
            offset += Buffer.byteLength(v);
            msg.writeUInt8(0, offset++);
        }
        msg.writeUInt8(0, offset);

        socket.write(msg);
    });
}