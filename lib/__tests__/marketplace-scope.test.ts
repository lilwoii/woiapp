import {
  createMarketplaceScopeGuard,
  resolveMarketplaceScope,
} from '@/lib/marketplace-scope';

describe('marketplace account scope', () => {
  test('derives authenticated and non-authenticated cache identities', () => {
    expect(resolveMarketplaceScope('authenticated', 'user-a')).toEqual({
      authenticatedUserId: 'user-a',
      key: 'account:user-a',
    });
    expect(resolveMarketplaceScope('loading', 'user-a')).toEqual({
      authenticatedUserId: null,
      key: 'session:loading:account-present',
    });
    expect(resolveMarketplaceScope('anonymous', null)).toEqual({
      authenticatedUserId: null,
      key: 'session:anonymous:no-account',
    });
  });

  test('rejects work captured before sign-out even when it resolves later', async () => {
    const guard = createMarketplaceScopeGuard('account:user-a');
    const request = guard.begin('account:user-a', 'access')!;
    let resolveRequest!: () => void;
    const delayedResult = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    }).then(() => guard.isCurrent(request));

    expect(guard.activate('session:anonymous:no-account')).toBe(true);
    resolveRequest();

    await expect(delayedResult).resolves.toBe(false);
    expect(guard.currentScopeKey()).toBe('session:anonymous:no-account');
  });

  test('rejects account A work after a rapid switch to account B', () => {
    const guard = createMarketplaceScopeGuard('account:user-a');
    const accountAListing = guard.begin('account:user-a', 'place:private-listing')!;
    const accountAFollow = guard.begin('account:user-a', 'follow:private-listing')!;

    guard.activate('account:user-b');
    const accountBListing = guard.begin('account:user-b', 'place:private-listing')!;

    expect(guard.isCurrent(accountAListing)).toBe(false);
    expect(guard.isCurrent(accountAFollow)).toBe(false);
    expect(guard.isCurrent(accountBListing)).toBe(true);
  });

  test('lets a newer search supersede an older search without canceling other lanes', () => {
    const guard = createMarketplaceScopeGuard('account:user-a');
    const olderSearch = guard.begin('account:user-a', 'directory')!;
    const reviews = guard.begin('account:user-a', 'reviews:business-a')!;
    const newerSearch = guard.begin('account:user-a', 'directory')!;

    expect(guard.isCurrent(olderSearch)).toBe(false);
    expect(guard.isCurrent(newerSearch)).toBe(true);
    expect(guard.isCurrent(reviews)).toBe(true);
    expect(guard.activate('account:user-a')).toBe(false);
  });

  test('refuses requests for a stale scope or an unnamed operation lane', () => {
    const guard = createMarketplaceScopeGuard('account:user-b');

    expect(guard.begin('account:user-a', 'directory')).toBeNull();
    expect(guard.begin('account:user-b', '')).toBeNull();
  });
});
