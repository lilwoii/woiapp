export type MarketplaceScope = Readonly<{
  authenticatedUserId: string | null;
  key: string;
}>;

export type MarketplaceRequestToken = Readonly<{
  epoch: number;
  lane: string;
  scopeKey: string;
  sequence: number;
}>;

export type MarketplaceScopeGuard = {
  activate: (scopeKey: string) => boolean;
  begin: (expectedScopeKey: string, lane: string) => MarketplaceRequestToken | null;
  currentScopeKey: () => string;
  isCurrent: (token: MarketplaceRequestToken) => boolean;
};

export function resolveMarketplaceScope(
  authStatus: string,
  accountId: string | null | undefined
): MarketplaceScope {
  const authenticatedUserId =
    authStatus === 'authenticated' && accountId ? accountId : null;
  return {
    authenticatedUserId,
    key: authenticatedUserId
      ? `account:${authenticatedUserId}`
      : `session:${authStatus}:${accountId ? 'account-present' : 'no-account'}`,
  };
}

export function createMarketplaceScopeGuard(initialScopeKey: string): MarketplaceScopeGuard {
  let epoch = 0;
  let scopeKey = initialScopeKey;
  let sequence = 0;
  const latestSequenceByLane = new Map<string, number>();

  return {
    activate(nextScopeKey) {
      if (nextScopeKey === scopeKey) return false;
      scopeKey = nextScopeKey;
      epoch += 1;
      latestSequenceByLane.clear();
      return true;
    },
    begin(expectedScopeKey, lane) {
      if (!lane || expectedScopeKey !== scopeKey) return null;
      const requestSequence = ++sequence;
      latestSequenceByLane.set(lane, requestSequence);
      return {
        epoch,
        lane,
        scopeKey,
        sequence: requestSequence,
      };
    },
    currentScopeKey() {
      return scopeKey;
    },
    isCurrent(token) {
      return token.epoch === epoch &&
        token.scopeKey === scopeKey &&
        latestSequenceByLane.get(token.lane) === token.sequence;
    },
  };
}
