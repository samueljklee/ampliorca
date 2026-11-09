import { open } from 'node:fs/promises'

/** Advance only after complete UTF-8 lines are accepted by the current lifecycle. */
export async function readBridgeFeedLines(
  path: string,
  offset: number,
  isCurrent: () => boolean,
  accept: (line: string, through: number) => void | Promise<void>
): Promise<number> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (!isCurrent()) {
      return offset
    }
    if (size <= offset) {
      return size
    }
    let position = offset
    const fragments: Buffer[] = []
    let fragmentBytes = 0
    while (position < size && isCurrent()) {
      const buffer = Buffer.alloc(Math.min(65_536, size - position))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (!bytesRead || !isCurrent()) {
        break
      }
      const chunkStart = position
      position += bytesRead
      const chunk = buffer.subarray(0, bytesRead)
      let start = 0
      let newline: number
      while ((newline = chunk.indexOf(10, start)) !== -1 && isCurrent()) {
        const fragment = chunk.subarray(start, newline)
        fragments.push(fragment)
        const line = Buffer.concat(fragments, fragmentBytes + fragment.length)
        fragments.length = 0
        fragmentBytes = 0
        const through = chunkStart + newline + 1
        await accept(line.toString('utf8'), through)
        if (!isCurrent()) {
          return offset
        }
        offset = through
        start = newline + 1
      }
      if (start < bytesRead) {
        const remainder = chunk.subarray(start)
        fragments.push(remainder)
        fragmentBytes += remainder.length
      }
    }
    return offset
  } finally {
    await file.close()
  }
}
