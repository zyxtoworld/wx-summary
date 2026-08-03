import assert from 'node:assert/strict';
import { readFileHandleBounded } from '../src/lib/bounded-read.js';

function fakeHandle({ initialSize, finalSize, data, initialMtime = 1, finalMtime = initialMtime }) {
  let statCalls = 0;
  const source = Buffer.from(data);
  return {
    async stat() {
      statCalls += 1;
      const initial = statCalls === 1;
      return {
        size: initial ? initialSize : finalSize,
        dev: 1,
        ino: 1,
        mtimeMs: initial ? initialMtime : finalMtime,
        ctimeMs: initial ? initialMtime : finalMtime,
      };
    },
    async read(target, offset, length, position) {
      const bytesRead = Math.max(0, Math.min(length, source.length - position));
      if (bytesRead) source.copy(target, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
}

async function main() {
  const stable = await readFileHandleBounded(fakeHandle({
    initialSize: 3,
    finalSize: 3,
    data: 'abc',
  }), 16);
  assert.equal(stable.toString('utf8'), 'abc', 'stable bounded reads should return the full file');

  await assert.rejects(
    readFileHandleBounded(fakeHandle({
      initialSize: 3,
      finalSize: 4,
      data: 'abcd',
    }), 16),
    error => error?.code === 'bounded_read_changed' && error?.status === 409,
    'a file that grows after the first stat must not be returned as a truncated prefix',
  );

  await assert.rejects(
    readFileHandleBounded(fakeHandle({
      initialSize: 4,
      finalSize: 3,
      data: 'abc',
    }), 16),
    error => error?.code === 'bounded_read_changed',
    'a file that shrinks during the read must be retried instead of parsed as partial content',
  );

  await assert.rejects(
    readFileHandleBounded(fakeHandle({
      initialSize: 3,
      finalSize: 3,
      initialMtime: 1,
      finalMtime: 2,
      data: 'xyz',
    }), 16),
    error => error?.code === 'bounded_read_changed',
    'same-size replacements must be rejected when the file version changes',
  );
  console.log('bounded read tests passed');
}

await main();
