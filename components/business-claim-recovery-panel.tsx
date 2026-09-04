import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { featureFlags } from '@/lib/features';
import {
  fetchMyBusinessClaims,
  withdrawBusinessClaim,
} from '@/lib/marketplace-api';
import { confirmAction } from '@/lib/platform-dialog';
import type {
  BusinessClaim,
  BusinessClaimMethod,
  BusinessClaimState,
} from '@/types/marketplace';

type BusinessClaimRecoveryPanelProps = {
  expectedUserId: string | null;
  secureSession: boolean;
  refreshToken: number;
  submitting: boolean;
};

const claimStateMeta: Record<
  BusinessClaimState,
  {
    label: string;
    icon: keyof typeof FontAwesome6.glyphMap;
    color: string;
    background: string;
  }
> = {
  pending: {
    label: 'Pending',
    icon: 'clock',
    color: palette.warning,
    background: palette.warningSoft,
  },
  approved: {
    label: 'Approved',
    icon: 'circle-check',
    color: palette.success,
    background: palette.successSoft,
  },
  rejected: {
    label: 'Rejected',
    icon: 'circle-exclamation',
    color: palette.accentDeep,
    background: palette.accentSoft,
  },
  withdrawn: {
    label: 'Withdrawn',
    icon: 'rotate-left',
    color: palette.muted,
    background: palette.bg,
  },
};

const claimMethodLabels: Record<BusinessClaimMethod, string> = {
  listed_phone: 'Listed phone',
  domain_email: 'Domain email',
  document: 'Document',
  permit: 'Permit',
};

function formatClaimDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Submitted recently';
  return `Submitted ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp))}`;
}

export default function BusinessClaimRecoveryPanel({
  expectedUserId,
  secureSession,
  refreshToken,
  submitting,
}: BusinessClaimRecoveryPanelProps) {
  const auth = useAuth();
  const [claims, setClaims] = useState<BusinessClaim[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [claimsRetryVersion, setClaimsRetryVersion] = useState(0);
  const [claimActionError, setClaimActionError] = useState<string | null>(null);
  const [withdrawingClaimId, setWithdrawingClaimId] = useState<string | null>(null);
  const mounted = useRef(true);
  const claimsRequestGeneration = useRef(0);
  const claimMutationGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      claimsRequestGeneration.current += 1;
      claimMutationGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const requestGeneration = claimsRequestGeneration.current + 1;
    claimsRequestGeneration.current = requestGeneration;
    const accountAtStart = expectedUserId;
    let active = true;

    if (
      !featureFlags.businessClaims ||
      !accountAtStart ||
      auth.status !== 'authenticated' ||
      !secureSession
    ) {
      return () => {
        active = false;
      };
    }

    const loadingTimer = setTimeout(() => {
      if (!active || !mounted.current) return;
      setClaimsLoading(true);
      setClaimsError(null);
    }, 0);
    void fetchMyBusinessClaims(accountAtStart)
      .then((result) => {
        if (
          !active ||
          !mounted.current ||
          claimsRequestGeneration.current !== requestGeneration ||
          auth.account?.id !== accountAtStart
        ) {
          return;
        }
        setClaimsLoading(false);
        if (!result.ok) {
          setClaimsError(result.reason);
          return;
        }
        setClaims(result.data ?? []);
      })
      .catch(() => {
        if (
          !active ||
          !mounted.current ||
          claimsRequestGeneration.current !== requestGeneration ||
          auth.account?.id !== accountAtStart
        ) {
          return;
        }
        setClaimsLoading(false);
        setClaimsError('Your ownership claims could not be loaded. Try again.');
      });

    return () => {
      active = false;
      clearTimeout(loadingTimer);
      claimsRequestGeneration.current += 1;
    };
  }, [
    auth.account?.id,
    auth.status,
    claimsRetryVersion,
    expectedUserId,
    refreshToken,
    secureSession,
  ]);

  const refreshClaims = () => {
    if (claimsLoading) return;
    setClaimsError(null);
    setClaimsLoading(true);
    setClaimsRetryVersion((current) => current + 1);
  };

  const withdrawClaim = async (claim: BusinessClaim) => {
    if (
      !featureFlags.businessClaims ||
      claim.state !== 'pending' ||
      withdrawingClaimId ||
      submitting ||
      !expectedUserId ||
      auth.status !== 'authenticated' ||
      auth.account?.id !== expectedUserId ||
      !secureSession
    ) {
      return;
    }
    const accountAtStart = expectedUserId;
    const mutationGeneration = claimMutationGeneration.current + 1;
    claimMutationGeneration.current = mutationGeneration;
    setWithdrawingClaimId(claim.id);
    setClaimActionError(null);
    let confirmed = false;
    try {
      confirmed = await confirmAction({
        title: 'Withdraw this ownership claim?',
        message: 'This stops the pending review. You can submit a new claim later.',
        confirmLabel: 'Withdraw claim',
        destructive: true,
      });
    } catch {
      confirmed = false;
    }
    if (!mounted.current || claimMutationGeneration.current !== mutationGeneration) {
      return;
    }
    if (
      !confirmed ||
      expectedUserId !== accountAtStart ||
      auth.status !== 'authenticated' ||
      auth.account?.id !== accountAtStart ||
      !secureSession
    ) {
      setWithdrawingClaimId(null);
      if (!confirmed) return;
      setClaimActionError('Your secure account session changed. Refresh and try again.');
      return;
    }
    let result: Awaited<ReturnType<typeof withdrawBusinessClaim>>;
    try {
      result = await withdrawBusinessClaim(claim.id, accountAtStart);
    } catch {
      result = {
        ok: false,
        code: 'UNKNOWN',
        reason: 'This ownership claim could not be withdrawn. Try again.',
      };
    }
    if (
      !mounted.current ||
      claimMutationGeneration.current !== mutationGeneration ||
      expectedUserId !== accountAtStart ||
      auth.status !== 'authenticated' ||
      auth.account?.id !== accountAtStart
    ) {
      return;
    }
    setWithdrawingClaimId(null);
    if (!result.ok) {
      setClaimActionError(result.reason);
      return;
    }
    setClaims((current) =>
      current.map((item) =>
        item.id === claim.id ? { ...item, state: result.data?.state ?? 'withdrawn' } : item
      )
    );
  };

  return (
    <View accessibilityLabel="Your ownership claims" style={styles.claimsPanel}>
      <View style={styles.claimsHeader}>
        <View style={styles.claimsIcon}>
          <FontAwesome6 color={palette.accentDeep} name="key" size={14} />
        </View>
        <View style={styles.claimsHeaderCopy}>
          <Text style={styles.claimsTitle}>Your ownership claims</Text>
          <Text style={styles.claimsSubtitle}>
            Private account status. Verification evidence and reviewer details are never shown here.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={claimsError ? 'Retry loading ownership claims' : 'Refresh ownership claims'}
          accessibilityState={{ disabled: claimsLoading }}
          disabled={claimsLoading}
          hitSlop={4}
          onPress={refreshClaims}
          style={styles.claimRefreshButton}>
          {claimsLoading ? (
            <ActivityIndicator color={palette.accentDeep} size="small" />
          ) : (
            <FontAwesome6 color={palette.accentDeep} name="arrows-rotate" size={11} />
          )}
          <Text style={styles.claimRefreshText}>{claimsError ? 'Retry' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {claimsLoading ? (
        <View accessibilityLabel="Loading your ownership claims" style={styles.claimsLoading}>
          <ActivityIndicator color={palette.accentDeep} size="small" />
          <Text style={styles.claimsEmpty}>Loading claims…</Text>
        </View>
      ) : claimsError ? (
        <View style={styles.claimsErrorRow}>
          <Text accessibilityRole="alert" style={styles.claimsErrorText}>
            {claimsError}
          </Text>
        </View>
      ) : claims.length ? (
        <View style={styles.claimsList}>
          {claims.map((claim) => {
            const status = claimStateMeta[claim.state];
            const businessLabel = claim.businessName ?? 'Spottr listing';
            const canWithdraw = claim.state === 'pending';
            const withdrawing = withdrawingClaimId === claim.id;
            return (
              <View key={claim.id} style={styles.claimStatusRow}>
                <View style={[styles.claimStatusIcon, { backgroundColor: status.background }]}>
                  <FontAwesome6 color={status.color} name={status.icon} size={12} />
                </View>
                <View style={styles.claimStatusCopy}>
                  <Text numberOfLines={1} style={styles.claimStatusName}>
                    {businessLabel}
                  </Text>
                  <Text style={styles.claimStatusMeta}>
                    {claimMethodLabels[claim.method]} · {formatClaimDate(claim.createdAt)}
                  </Text>
                </View>
                <View style={styles.claimStatusSide}>
                  <View style={[styles.claimStatePill, { backgroundColor: status.background }]}>
                    <Text style={[styles.claimStateText, { color: status.color }]}>{status.label}</Text>
                  </View>
                  {canWithdraw ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Withdraw pending claim for ${businessLabel}`}
                      accessibilityState={{ disabled: Boolean(withdrawingClaimId) }}
                      disabled={Boolean(withdrawingClaimId)}
                      hitSlop={4}
                      onPress={() => void withdrawClaim(claim)}
                      style={styles.claimWithdrawButton}>
                      {withdrawing ? (
                        <ActivityIndicator color={palette.accentDeep} size="small" />
                      ) : (
                        <Text style={styles.claimWithdrawText}>Withdraw</Text>
                      )}
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={styles.claimsEmpty}>No ownership claims yet.</Text>
      )}
      {claimActionError ? (
        <Text accessibilityRole="alert" style={styles.claimActionError}>
          {claimActionError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  claimsPanel: {
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  claimsHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  claimsIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  claimsHeaderCopy: {
    flex: 1,
    gap: 3,
    minWidth: 150,
  },
  claimsTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  claimsSubtitle: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  claimRefreshButton: {
    alignItems: 'center',
    borderColor: palette.accentDeep,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  claimRefreshText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  claimsLoading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 32,
  },
  claimsEmpty: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  claimsErrorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  claimsErrorText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  claimsList: {
    gap: spacing.sm,
  },
  claimStatusRow: {
    alignItems: 'flex-start',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.md,
  },
  claimStatusIcon: {
    alignItems: 'center',
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  claimStatusCopy: {
    flexBasis: 140,
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  claimStatusName: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  claimStatusMeta: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  claimStatusSide: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginLeft: 'auto',
  },
  claimStatePill: {
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  claimStateText: {
    fontSize: 11,
    fontWeight: '900',
  },
  claimWithdrawButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  claimWithdrawText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  claimActionError: {
    color: palette.accentDeep,
    fontSize: 12,
    lineHeight: 18,
  },
});
