export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 4768;

export function daemonHttpUrl(host = DEFAULT_DAEMON_HOST, port = DEFAULT_DAEMON_PORT): string {
  return `http://${host}:${port}`;
}

export function daemonWebSocketUrl(host = DEFAULT_DAEMON_HOST, port = DEFAULT_DAEMON_PORT): string {
  return `ws://${host}:${port}/v1/events`;
}

