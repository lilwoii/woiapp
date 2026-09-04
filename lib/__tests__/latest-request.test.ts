import { createLatestRequestGate } from '../latest-request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe('latest request gate', () => {
  it('suppresses request A after invalidation and accepts newer request B', async () => {
    const gate = createLatestRequestGate();
    const commits: string[] = [];
    const requestA = deferred<string>();
    const tokenA = gate.begin();
    const consumeA = requestA.promise.then((value) => {
      if (gate.isCurrent(tokenA)) commits.push(value);
    });

    gate.invalidate();

    const requestB = deferred<string>();
    const tokenB = gate.begin();
    const consumeB = requestB.promise.then((value) => {
      if (gate.isCurrent(tokenB)) commits.push(value);
    });

    requestA.resolve('A');
    requestB.resolve('B');
    await Promise.all([consumeA, consumeB]);

    expect(commits).toEqual(['B']);
    expect(gate.isCurrent(tokenA)).toBe(false);
    expect(gate.isCurrent(tokenB)).toBe(true);
  });

  it('allows a current request error to recover on retry', async () => {
    const gate = createLatestRequestGate();
    const states: string[] = [];
    const firstAttempt = deferred<string>();
    const firstToken = gate.begin();
    const consumeFirstAttempt = firstAttempt.promise.catch(() => {
      if (gate.isCurrent(firstToken)) states.push('error');
    });

    firstAttempt.reject(new Error('temporary gateway failure'));
    await consumeFirstAttempt;
    expect(states).toEqual(['error']);

    const retryAttempt = deferred<string>();
    const retryToken = gate.begin();
    const consumeRetry = retryAttempt.promise.then((value) => {
      if (gate.isCurrent(retryToken)) states.push(value);
    });

    retryAttempt.resolve('ready');
    await consumeRetry;

    expect(states).toEqual(['error', 'ready']);
    expect(gate.isCurrent(firstToken)).toBe(false);
    expect(gate.isCurrent(retryToken)).toBe(true);
  });
});
