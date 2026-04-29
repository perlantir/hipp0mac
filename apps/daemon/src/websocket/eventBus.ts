import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { OperatorEventSchema, type OperatorEvent } from "@operator-dock/protocol";

type EventListener = (event: OperatorEvent) => void;
type WebSocketClient = {
  readonly readyState: number;
  send(payload: string): void;
  on(event: "close", listener: () => void): void;
};

const websocketOpenState = 1;

export class EventBus {
  private readonly clients = new Set<WebSocketClient>();
  private readonly listeners = new Set<EventListener>();

  addClient(client: WebSocketClient): void {
    this.clients.add(client);
    client.on("close", () => {
      this.clients.delete(client);
    });
  }

  publish(event: OperatorEvent): void {
    const parsed = OperatorEventSchema.parse(event);
    const payload = JSON.stringify(parsed);

    for (const client of this.clients) {
      if (client.readyState === websocketOpenState) {
        client.send(payload);
      }
    }

    for (const listener of this.listeners) {
      listener(parsed);
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export async function registerEventRoutes(app: FastifyInstance, eventBus: EventBus): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/v1/events", { websocket: true }, (socket) => {
    eventBus.addClient(socket);
  });
}
