import { createSocket } from "node:dgram";

/** Resolve only after the broadcast has been handed to the network stack. */
export function wake(mac: string, address: string): Promise<void> {
  const hardwareAddress = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  const packet = Buffer.alloc(102, 0xff);
  for (let offset = 6; offset < packet.length; offset += 6) {
    hardwareAddress.copy(packet, offset);
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = createSocket("udp4");
  let finished = false;
  const finish = (error?: Error | null) => {
    if (finished) return;
    finished = true;
    socket.close();
    if (error) reject(error);
    else resolve();
  };
  socket.once("error", finish);
  socket.bind(() => {
    try {
      socket.setBroadcast(true);
      socket.send(packet, 9, address, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return promise;
}
