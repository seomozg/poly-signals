import {describe, expect, it} from 'vitest';
import {chunk, mapPool} from '@/lib/pool';

describe('chunk', () => {
  it('splits into fixed-size pieces', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('mapPool', () => {
  it('preserves order and results', async () => {
    const results = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let peak = 0;

    await mapPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('rejects when a task fails', async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });

  it('handles an empty list', async () => {
    expect(await mapPool([], 3, async (n) => n)).toEqual([]);
  });
});
