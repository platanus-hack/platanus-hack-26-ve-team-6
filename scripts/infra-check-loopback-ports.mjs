import net from 'node:net';

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', reject);
  });
}

for (const portText of process.argv.slice(2)) {
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('Loopback port validation received an invalid port.\n');
    process.exit(1);
  }
  let connected = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await connect(port);
      connected = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!connected) {
    process.stderr.write(`Loopback service port ${port} is not accepting connections.\n`);
    process.exit(1);
  }
}
