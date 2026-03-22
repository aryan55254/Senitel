
/**
 * protocol encoder : 
    * Wraps a payload into a standard Postgres message: [Type][Length][Payload]
    * we make the payload ourself we just wrap it in the pg wire format instead of any complex logic liek what we had done in the protocl decoder so ts ezz 
    */

import { FrontendMessageCode, BackendMessageCode } from "./pg_wire_message_types";

export class ProtocolEncoder {
    public static encode(type: BackendMessageCode | FrontendMessageCode, payload: Buffer): Buffer {
        const length = payload.length + 4; // Length field itself is 4 bytes
        const header = Buffer.alloc(5);

        header.writeUInt8(type as number, 0);
        header.writeUInt32BE(length, 1);

        return Buffer.concat([header, payload]);
    }

    /**
     * Internal helper for Diagnostic messages (Error 'E' and Notice 'N').
     * They share the exact same internal field structure.
     */
    private static encodeDiagnostic(type: BackendMessageCode, message: string, severity: string, code: string): Buffer {
        // Fields: [Code (1 byte)][String][Null Terminator]
        const fields = [
            Buffer.from(`S${severity}\0`), // Severity
            Buffer.from(`C${code}\0`),     // SQLState code
            Buffer.from(`M${message}\0`),  // The actual message
            Buffer.alloc(1, 0)              // The final null terminator for the whole message
        ];

        const payload = Buffer.concat(fields);
        return this.encode(type, payload);
    }

    public static encodeError(message: string, severity: string = 'ERROR', code: string = '08000'): Buffer {
        return this.encodeDiagnostic(BackendMessageCode.ErrorMessage, message, severity, code);
    }

    public static encodeNotice(message: string, severity: string = 'NOTICE', code: string = '00000'): Buffer {
        return this.encodeDiagnostic(BackendMessageCode.NoticeMessage, message, severity, code);
    }
}
