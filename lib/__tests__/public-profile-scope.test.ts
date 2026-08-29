type NodeFs = { readFileSync: (path: string, encoding: 'utf8') => string };
type NodePath = { resolve: (...parts: string[]) => string };
declare function require(name: 'fs'): NodeFs;
declare function require(name: 'path'): NodePath;
declare const __dirname: string;

const { readFileSync } = require('fs');
const { resolve } = require('path');

const profileScreen = readFileSync(
  resolve(__dirname, '../../app/profile/[id].tsx'),
  'utf8',
);
const authContext = readFileSync(
  resolve(__dirname, '../../context/auth-context.tsx'),
  'utf8',
);

describe('public profile viewer scope contract', () => {
  it('remounts the route for account, auth, and security scope changes', () => {
    expect(profileScreen).toMatch(/const auth = useAuth\(\)/);
    expect(profileScreen).toMatch(/const accountId = auth\.status === 'authenticated'/);
    expect(profileScreen).toMatch(/const profileScopeKey = `\$\{auth\.status\}:\$\{accountId \?\? 'none'\}:epoch-\$\{auth\.sessionEpoch\}:hydrating-\$\{auth\.sessionHydrating\}:ready-\$\{auth\.sessionReady\}:/);
    expect(profileScreen).toMatch(/key=\{`\$\{profileScopeKey\}:profile:\$\{id \?\? 'missing-profile'\}`\}/);
  });

  it('clears and rejects delayed viewer-specific snapshots while retaining public loading', () => {
    expect(profileScreen).toMatch(/scopeKey: string/);
    expect(profileScreen).toMatch(/snapshot\.scopeKey === scopeKey/);
    expect(profileScreen).toMatch(/key=\{`\$\{profileScopeKey\}:profile:/);
    expect(profileScreen).toMatch(/profileRequestGeneration\.current !== generation/);
    expect(profileScreen).toMatch(/!isCurrentScope\(requestedId, requestedScopeKey\)/);
    expect(profileScreen).toMatch(/mounted\.current = false/);
    expect(profileScreen).toMatch(/void fetchPublicProfile\(id\)/);
    expect(profileScreen).toMatch(/followedByViewer: current\.profile\.followedByViewer/);
    expect(profileScreen).toMatch(/followerCount: current\.profile\.followerCount/);
    expect(profileScreen).toMatch(/const sessionAuthoritative = auth\.sessionReady && !auth\.sessionHydrating/);
    expect(profileScreen).toMatch(/if \(!id \|\| !sessionAuthoritative\) return/);
    expect(profileScreen).toMatch(/if \(!sessionAuthoritative\) return;/);
  });

  it('publishes every session hydration transition, including deferred auth events', () => {
    expect(authContext).toMatch(/sessionEpoch: number/);
    expect(authContext).toMatch(/sessionHydrating: boolean/);
    expect(authContext).toMatch(/sessionReady: boolean/);
    expect(authContext).toMatch(/const \[sessionEpoch, setSessionEpoch\]/);
    expect(authContext).toMatch(/const \[sessionHydrating, setSessionHydrating\] = useState\(isSupabaseConfigured\)/);
    expect(authContext).toMatch(/const \[sessionReady, setSessionReady\] = useState\(!isSupabaseConfigured\)/);
    expect(authContext).toMatch(/const publishSessionHydration = useCallback/);
    expect(authContext).toMatch(/setSessionHydrating\(true\)/);
    expect(authContext).toMatch(/setSessionReady\(false\)/);
    expect(authContext).toMatch(/const finishSessionHydration = useCallback/);
    expect(authContext).toMatch(/sessionHydration\.isCurrent\(token\)/);
    expect(authContext).toMatch(/setSessionHydrating\(false\)/);
    expect(authContext).toMatch(/setSessionReady\(true\)/);
    expect(authContext).toMatch(/publishSessionHydration\(sessionHydration\.begin\(/);
    expect(authContext).toMatch(/publishSessionHydration\(sessionHydration\.advance\(/);
    expect(authContext).toMatch(/let initialRestoreOutcome: boolean \| null = null/);
    expect(authContext).toMatch(/initialRestoreOutcome = restoreSucceeded;[\s\S]*?initialRestoreBarrier\.settle\(restoreSucceeded\)/);
    expect(authContext).toMatch(/const processAuthEvent = \(restoreSucceeded: boolean\)[\s\S]*?canProcessAuthEventAfterInitialRestore[\s\S]*?publishSessionHydration\(sessionHydration\.advance\(\)\)/);
    expect(authContext).toMatch(/if \(initialRestoreOutcome !== null\)[\s\S]*?processAuthEvent\(initialRestoreOutcome\)[\s\S]*?initialRestoreBarrier\.ready\.then\(processAuthEvent\)/);
  });
});
