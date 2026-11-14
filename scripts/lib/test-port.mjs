import { createConnection } from "node:net";
// Read-only refusal: never stop or reuse a service already occupying a test port.
export async function requireFreeTestPort(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(Error(`TEST_PORT_${port}_OCCUPIED`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(Error(`TEST_PORT_${port}_UNAVAILABLE`));
    });
  });
}
