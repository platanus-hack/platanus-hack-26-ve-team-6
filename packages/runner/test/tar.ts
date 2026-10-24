export function makeTar(entries: ReadonlyArray<{ path: string; content?: string; type?: string }>): Buffer {
  const records: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const block = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(block);
    records.push(header, block);
  }
  return Buffer.concat([...records, Buffer.alloc(1024)]);
}
