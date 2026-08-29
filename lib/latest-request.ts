export type LatestRequestToken = number;

export type LatestRequestGate = Readonly<{
  begin: () => LatestRequestToken;
  invalidate: () => void;
  isCurrent: (token: LatestRequestToken) => boolean;
}>;

/**
 * Keeps asynchronous work from committing after a newer request or an
 * explicit invalidation has made its result stale.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let latest = 0;

  return {
    begin() {
      latest += 1;
      return latest;
    },
    invalidate() {
      latest += 1;
    },
    isCurrent(token) {
      return token === latest;
    },
  };
}
