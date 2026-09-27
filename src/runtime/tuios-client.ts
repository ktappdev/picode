import { createConnection, type Socket } from "node:net";

export type JsonRecord = Record<string, unknown>;
const MAX_LINE = 16 * 1024 * 1024;
let nextId = 0;

export function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid TUIOS response: expected an object");
  }
  return value as JsonRecord;
}

function parseLine(line: string): JsonRecord {
  return record(JSON.parse(line) as unknown);
}

/** TUIOS is newline-delimited JSON. Do not use the Herdr-compatible report
 * socket: it accepts state reports only, not control verbs. */
export class TuiosClient {
  constructor(readonly socketPath: string) {
    if (!socketPath) throw new Error("TUIOS_SOCKET is missing");
  }

  request(verb: string, params: JsonRecord = {}, timeoutMs = 15_000): Promise<JsonRecord> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const id = ++nextId;
      let buffer = "";
      let finished = false;
      const timeout = setTimeout(() => finish(new Error(`TUIOS ${verb} timed out`)), timeoutMs);
      const finish = (error?: Error, result?: JsonRecord) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(result ?? {});
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, verb, params })}\n`));
      socket.on("error", error => finish(error));
      socket.on("close", () => finish(new Error(`TUIOS disconnected during ${verb}`)));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE) return finish(new Error("TUIOS response too large"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = parseLine(buffer.slice(0, newline));
          if (response.id !== id) throw new Error(`TUIOS ${verb} response ID mismatch`);
          if (response.error) {
            const error = record(response.error);
            throw new Error(
              `TUIOS ${verb}: ${String(error.code || "error")}: ${String(error.message || "unknown error")}`,
            );
          }
          if (!response.result) throw new Error(`TUIOS ${verb}: result missing`);
          finish(undefined, record(response.result));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  /** Caller owns the returned stop function. No global socket starts during
   * extension registration; subscriptions are established at session_start. */
  subscribe(
    params: JsonRecord,
    onEvent: (event: JsonRecord) => void,
    onDisconnect: (error: Error) => void,
    onAck?: (ack: JsonRecord) => void,
    ackTimeoutMs = 15_000,
  ): () => void {
    const socket: Socket = createConnection(this.socketPath);
    const id = ++nextId;
    let buffer = "";
    let acked = false;
    let stopped = false;
    const ackTimer = setTimeout(() => {
      fail(new Error("TUIOS subscribe timed out waiting for acknowledgement"));
    }, ackTimeoutMs);
    const fail = (error: Error) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(ackTimer);
      socket.destroy();
      onDisconnect(error);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id, verb: "subscribe", params })}\n`),
    );
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("TUIOS subscription closed")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) return fail(new Error("TUIOS event too large"));
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && !stopped) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const value = parseLine(line);
          if (!acked) {
            if (value.id !== id) throw new Error("TUIOS subscribe response ID mismatch");
            if (value.error) throw new Error(`TUIOS subscribe: ${JSON.stringify(value.error)}`);
            const ack = record(value.result);
            if (ack.type !== "subscribed") throw new Error("TUIOS subscribe ack missing");
            acked = true;
            clearTimeout(ackTimer);
            onAck?.(ack);
          } else {
            onEvent(value);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        newline = buffer.indexOf("\n");
      }
    });
    return () => {
      stopped = true;
      clearTimeout(ackTimer);
      socket.destroy();
    };
  }
}
