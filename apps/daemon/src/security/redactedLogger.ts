import { Writable } from "node:stream";
import { redactText } from "../tools/runtime/secretRedaction.js";

export interface RedactedLoggerOptions {
  enabled: boolean;
  stream?: Writable;
}

export function fastifyLoggerOptions(options: RedactedLoggerOptions): boolean | { stream: Writable } {
  if (!options.enabled) {
    return false;
  }

  return {
    stream: new RedactingWritable(options.stream)
  };
}

class RedactingWritable extends Writable {
  constructor(private readonly sink: Writable | NodeJS.WriteStream = process.stdout) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sink.write(redactText(chunk.toString("utf8")), callback);
  }
}
