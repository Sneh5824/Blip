import { io } from "socket.io-client";
import { BACKEND_URL } from "./config";

let _socket = null;

/** Returns the shared Socket.IO singleton. Creates it on first call. */
export function getSocket() {
  if (!_socket) {
    _socket = io(BACKEND_URL, {
      transports: ["websocket", "polling"],
      autoConnect: true,
    });

    _socket.on("connect",    () => console.log("[Socket] Connected:", _socket.id));
    _socket.on("disconnect", () => console.log("[Socket] Disconnected"));
    _socket.on("connect_error", (err) => console.warn("[Socket] Error:", err.message));
  }
  return _socket;
}

/** Disconnect and destroy the singleton (call on room expire / unmount). */
export function destroySocket() {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}
