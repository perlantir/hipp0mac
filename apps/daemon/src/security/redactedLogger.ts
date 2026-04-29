import { Writable } from "node:stream";
import { redactText } from "../tools/runtime/secretRedaction.js";

export function redactedLogStream(destination: NodeJS.WritableStream = process.stdout): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      destination.write(redactText(chunk.toString("utf8")));
      callback();
    }
  });
}

export function redactedFastifyLoggerOptions(destination?: NodeJS.WritableStream) {
  return {
    stream: redactedLogStream(destination)
  };
}
