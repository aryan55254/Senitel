/**
 * PostgreSQL Protocol Decoder
 * * RESPONSIBILITIES:
 *Accumulate raw TCP chunks into a "Frame Buffer".
 *Identify message boundaries using the [Type][Length] header.
 *Handle the "Headerless" StartupMessage (special case).
 *Emit complete, validated PostgreSQL messages to the ProxySession.
 */
import { Buffer } from "buffer";
import { FrontendMessageCode, BackendMessageCode } from "./pg_wire_message_types";

export interface DecodedMessage {
    type: FrontendMessageCode | BackendMessageCode | number;
    payload: Buffer;
    raw: Buffer;
}

export class ProtocolDecoder {

    constructor(private mode: 'frontend' | 'backend') { }

    private accumulator: Buffer = Buffer.alloc(0);

    private ishandshakecomplete: boolean = false;

    /**
     * Called every time the socket emits a 'data' chunk.
     */
    public parse(chunk: Buffer) {
        console.log(`[ProtocolDecoder:${this.mode}] Received chunk of ${chunk.length} bytes`);
        this.accumulator = Buffer.concat([this.accumulator, chunk]);
        const messages: DecodedMessage[] = [];

        while (this.accumulator.length >= 4) {
            let totalSize: number;

            if (!this.ishandshakecomplete) {
                // No Type byte. Length is at Index 0.
                totalSize = this.accumulator.readInt32BE(0);
            } else {

                if (this.accumulator.length < 5) break;
                totalSize = 1 + this.accumulator.readInt32BE(1);

            }

            if (this.accumulator.length < totalSize) {
                break; // Wait for the next TCP 'data' event
            }

            // EXTRACTION
            const rawMessage = this.accumulator.subarray(0, totalSize);

            // MAP TO ENUMS
            const typeByte = this.ishandshakecomplete ? rawMessage[0] : 0x00; // 0x00 for Startup
            const type = this.mode === 'frontend'
                ? typeByte as FrontendMessageCode
                : typeByte as BackendMessageCode;

            messages.push({
                type: type,
                payload: this.ishandshakecomplete ? rawMessage.subarray(5) : rawMessage.subarray(4),
                raw: rawMessage
            });
            console.log(`[ProtocolDecoder:${this.mode}] Successfully parsed message of type ${type.toString(16)} (size: ${totalSize})`);

            // CLEANUP & STATE UPDATE
            this.accumulator = this.accumulator.subarray(totalSize);

            // The very first message handled is ALWAYS the Startup.
            // Everything after MUST be a standard message.
            if (!this.ishandshakecomplete) {
                this.ishandshakecomplete = true;
            }
            // the loop continue 

        }
        return messages;
    }

    public reset() {
        this.accumulator = Buffer.alloc(0);
        this.ishandshakecomplete = false;
    }

}