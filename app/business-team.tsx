import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  AssignableBusinessTeamRole,
  BusinessTeamInvitation,
  BusinessTeamMember,
  BusinessTeamResult,
  BusinessTeamWorkspace,
  capabilitiesForRole,
  changeBusinessMemberRole,
  createTeamIdempotencyKey,
  inviteBusinessTeamMember,
  loadBusinessTeam,
  loadMyBusinessInvitations,
  respondToBusinessInvitation,
  revokeBusinessTeamInvitation,
  revokeBusinessTeamAccess,
  transferBusinessOwnership,
} from '@/lib/business-team';
import { confirmAction } from '@/lib/platform-dialog';

type Feedback = {
  tone: 'error' | 'success';
  message: string;
};

const roleDescriptions: Record<AssignableBusinessTeamRole, string> = {
  manager:
    'Can run service and invite or remove staff. Ownership controls stay with the owner.',
  staff:
    'Can view the managed workspace. Staff cannot manage team access, roles, or ownership.',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatDate(value: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : 'Not recorded';
}

function roleLabel(role: BusinessTeamMember['role']) {
  return role.charAt(0).toLocaleUpperCase('en-US') + role.slice(1);
}

function invitationStateLabel(state: BusinessTeamInvitation['state']) {
  if (state === 'pending') return 'Pending';
  if (state === 'accepted') return 'Accepted';
  if (state === 'declined') return 'Declined';
  if (state === 'revoked') return 'Cancelled';
  return 'Expired';
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('en-US') ?? '')
    .join('');
}

export default function BusinessTeamScreen() {
  const auth = useAuth();
  const params = useLocalSearchParams<{ businessId?: string | string[] }>();
  const businessId = Array.isArray(params.businessId)
    ? params.businessId[0] ?? ''
    : params.businessId ?? '';
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const [team, setTeam] = useState<BusinessTeamWorkspace | null>(null);
  const [personalInvitations, setPersonalInvitations] = useState<
    BusinessTeamInvitation[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [inviteTarget, setInviteTarget] = useState('');
  const [inviteRole, setInviteRole] =
    useState<AssignableBusinessTeamRole>('staff');
  const requestSequence = useRef(0);
  const inviteRequestKey = useRef<string | null>(null);
  const transferRequestKeys = useRef<Record<string, string>>({});

  const secureSession =
    auth.isConfigured &&
    auth.status === 'authenticated' &&
    auth.securityStatus === 'ready' &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === 'aal2';

  const refresh = useCallback(
    async (quiet = false) => {
      if (!secureSession || !businessId) return;
      const request = requestSequence.current + 1;
      requestSequence.current = request;
      if (!quiet) setLoading(true);
      setLoadError(null);
      setInboxError(null);

      const [teamResult, inboxResult] = await Promise.all([
        loadBusinessTeam(businessId),
        loadMyBusinessInvitations(),
      ]);
      if (requestSequence.current !== request) return;

      if (teamResult.ok) {
        setTeam(teamResult.data);
      } else {
        setTeam(null);
        setLoadError(teamResult.reason);
      }
      if (inboxResult.ok) {
        setPersonalInvitations(
          inboxResult.data.filter((invitation) => invitation.state === 'pending')
        );
      } else {
        setPersonalInvitations([]);
        setInboxError(inboxResult.reason);
      }
      setLoading(false);
    },
    [businessId, secureSession]
  );

  useEffect(() => {
    if (!secureSession || !businessId) return;
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      clearTimeout(timer);
      requestSequence.current += 1;
    };
  }, [businessId, refresh, secureSession]);

  const capabilities = useMemo(
    () => (team ? capabilitiesForRole(team.viewerRole) : null),
    [team]
  );

  const runMutation = async (
    key: string,
    action: () => Promise<BusinessTeamResult>,
    onSuccess?: () => void
  ) => {
    if (busyKey) return;
    setBusyKey(key);
    setFeedback(null);
    const result = await action();
    if (!result.ok) {
      setBusyKey(null);
      setFeedback({ tone: 'error', message: result.reason });
      return false;
    }
    onSuccess?.();
    setFeedback({
      tone: 'success',
      message: result.message ?? 'Team access updated.',
    });
    await refresh(true);
    setBusyKey(null);
    return true;
  };

  const sendInvitation = async () => {
    if (!team || !inviteTarget.trim() || busyKey) return;
    const key =
      inviteRequestKey.current ?? createTeamIdempotencyKey('invite');
    inviteRequestKey.current = key;
    await runMutation(
      'invite',
      () =>
        inviteBusinessTeamMember({
          businessId: team.businessId,
          target: inviteTarget,
          role: inviteRole,
          idempotencyKey: key,
        }),
      () => {
        inviteRequestKey.current = null;
        setInviteTarget('');
        setInviteRole('staff');
      }
    );
  };

  const changeRole = async (
    member: BusinessTeamMember,
    nextRole: AssignableBusinessTeamRole
  ) => {
    if (!team || member.role === nextRole || busyKey) return;
    const demotion = member.role === 'manager' && nextRole === 'staff';
    const confirmed = await confirmAction({
      title: `${demotion ? 'Reduce' : 'Change'} ${member.displayName}'s access?`,
      message: `${member.displayName} will become ${roleLabel(nextRole)}. ${roleDescriptions[nextRole]}`,
      confirmLabel: demotion ? 'Change to staff' : 'Change to manager',
      destructive: demotion,
    });
    if (!confirmed) return;
    await runMutation(`role:${member.memberPublicId}`, () =>
      changeBusinessMemberRole({
        businessId: team.businessId,
        memberPublicId: member.memberPublicId,
        role: nextRole,
      })
    );
  };

  const removeMember = async (member: BusinessTeamMember) => {
    if (!team || busyKey) return;
    const confirmed = await confirmAction({
      title: `Remove ${member.displayName}?`,
      message:
        'Their business access ends immediately. Their personal Spottr account is not deleted.',
      confirmLabel: 'Remove access',
      destructive: true,
    });
    if (!confirmed) return;
    await runMutation(`revoke:${member.memberPublicId}`, () =>
      revokeBusinessTeamAccess({
        businessId: team.businessId,
        memberPublicId: member.memberPublicId,
      })
    );
  };

  const transferOwnership = async (member: BusinessTeamMember) => {
    if (!team || busyKey) return;
    const confirmed = await confirmAction({
      title: `Transfer ownership to ${member.displayName}?`,
      message:
        'This takes effect immediately. They will control team roles and future ownership transfers. Your role will become manager.',
      confirmLabel: 'Transfer ownership',
      destructive: true,
    });
    if (!confirmed) return;
    const key =
      transferRequestKeys.current[member.memberPublicId] ??
      createTeamIdempotencyKey('transfer');
    transferRequestKeys.current[member.memberPublicId] = key;
    await runMutation(
      `transfer:${member.memberPublicId}`,
      () =>
        transferBusinessOwnership({
          businessId: team.businessId,
          memberPublicId: member.memberPublicId,
          idempotencyKey: key,
        }),
      () => {
        delete transferRequestKeys.current[member.memberPublicId];
      }
    );
  };

  const respondToInvitation = async (
    invitation: BusinessTeamInvitation,
    decision: 'accept' | 'decline'
  ) => {
    if (busyKey) return;
    if (decision === 'decline') {
      const confirmed = await confirmAction({
        title: `Decline ${invitation.businessName}'s invitation?`,
        message: 'The business can send another invitation later.',
        confirmLabel: 'Decline invitation',
        destructive: true,
      });
      if (!confirmed) return;
    }
    await runMutation(`invitation:${invitation.invitationId}`, () =>
      respondToBusinessInvitation({
        invitationId: invitation.invitationId,
        decision,
      })
    );
  };

  const cancelBusinessInvitation = async (
    invitation: BusinessTeamInvitation
  ) => {
    if (!team || busyKey || invitation.state !== 'pending') return;
    const confirmed = await confirmAction({
      title: `Cancel invitation for ${invitation.targetHint}?`,
      message:
        'The invitation will stop working immediately. You can send a new invitation later.',
      confirmLabel: 'Cancel invitation',
      destructive: true,
    });
    if (!confirmed) return;
    await runMutation(`revoke-invite:${invitation.invitationId}`, () =>
      revokeBusinessTeamInvitation({
        businessId: team.businessId,
        invitationId: invitation.invitationId,
      })
    );
  };

  const gate = (() => {
    if (!auth.isConfigured) {
      return {
        icon: 'plug-circle-xmark' as const,
        title: 'Team controls need Spottr live services.',
        body:
          'The preview never fabricates team access. Connect the production backend to manage real members and invitations.',
        action: null,
      };
    }
    if (auth.status === 'loading') {
      return {
        icon: 'shield-halved' as const,
        title: 'Checking secure access…',
        body: 'Spottr is verifying your current session.',
        action: null,
      };
    }
    if (auth.status !== 'authenticated') {
      return {
        icon: 'right-to-bracket' as const,
        title: 'Sign in to manage a team.',
        body: 'Business team controls are available only to authenticated members.',
        action: { label: 'Sign in', route: '/auth' as const },
      };
    }
    if (
      auth.securityStatus !== 'ready' ||
      !auth.mfaEnrolled ||
      auth.assuranceLevel !== 'aal2'
    ) {
      return {
        icon: 'mobile-screen-button' as const,
        title: 'Verify your authenticator.',
        body:
          'A current authenticator code is required before Spottr will read or change business team access.',
        action: { label: 'Open security', route: '/security' as const },
      };
    }
    if (!businessId) {
      return {
        icon: 'link-slash' as const,
        title: 'Choose a business from Studio.',
        body: 'This team link does not identify a managed business.',
        action: { label: 'Return to Studio', route: '/(tabs)/studio' as const },
      };
    }
    return null;
  })();

  if (gate) {
    return (
      <FocusAwareScreen>
        <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
          <PageShell narrow>
            <View style={styles.topbar}>
              <Pressable
                accessibilityLabel="Go back"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={styles.iconButton}>
                <FontAwesome6 color={palette.ink} name="arrow-left" size={15} />
              </Pressable>
              <BrandMark />
              <View style={styles.topbarSpacer} />
            </View>
            <View style={styles.gate}>
              <View style={styles.gateIcon}>
                {auth.status === 'loading' ? (
                  <ActivityIndicator color={palette.accentDeep} size="small" />
                ) : (
                  <FontAwesome6 color={palette.accentDeep} name={gate.icon} size={22} />
                )}
              </View>
              <Text accessibilityRole="header" style={styles.gateTitle}>
                {gate.title}
              </Text>
              <Text style={styles.gateBody}>{gate.body}</Text>
              {gate.action ? (
                <Pressable
                  accessibilityLabel={gate.action.label}
                  accessibilityRole="button"
                  onPress={() => router.push(gate.action!.route)}
                  style={styles.primaryButton}>
                  <Text style={styles.primaryButtonText}>{gate.action.label}</Text>
                  <FontAwesome6 color="#FFFFFF" name="arrow-right" size={12} />
                </Pressable>
              ) : null}
            </View>
          </PageShell>
        </ScrollView>
      </FocusAwareScreen>
    );
  }

  return (
    <FocusAwareScreen>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.screen}>
        <PageShell>
          <View style={styles.topbar}>
            <View style={styles.topbarStart}>
              <Pressable
                accessibilityLabel="Go back"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={styles.iconButton}>
                <FontAwesome6 color={palette.ink} name="arrow-left" size={15} />
              </Pressable>
              <BrandMark />
            </View>
            <View style={styles.securityBadge}>
              <FontAwesome6 color={palette.success} name="shield-halved" size={12} />
              <Text style={styles.securityBadgeText}>AAL2 protected</Text>
            </View>
          </View>

          <View style={styles.heading}>
            <Text style={styles.eyebrow}>Business access</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Team
            </Text>
            <Text style={styles.subtitle}>
              Invite the right people, keep roles minimal, and review access when staffing
              changes.
            </Text>
          </View>

          {feedback ? (
            <View
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
              style={[
                styles.feedback,
                feedback.tone === 'success' && styles.feedbackSuccess,
              ]}>
              <FontAwesome6
                color={
                  feedback.tone === 'success'
                    ? palette.success
                    : palette.accentDeep
                }
                name={
                  feedback.tone === 'success'
                    ? 'circle-check'
                    : 'triangle-exclamation'
                }
                size={13}
                solid
              />
              <Text
                style={[
                  styles.feedbackText,
                  feedback.tone === 'success' && styles.feedbackTextSuccess,
                ]}>
                {feedback.message}
              </Text>
            </View>
          ) : null}

          {personalInvitations.length ? (
            <View style={styles.inboxSection}>
              <View style={styles.sectionHeading}>
                <View style={styles.sectionHeadingCopy}>
                  <Text style={styles.sectionEyebrow}>For you</Text>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>
                    Pending invitations
                  </Text>
                </View>
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{personalInvitations.length}</Text>
                </View>
              </View>
              {personalInvitations.map((invitation) => {
                const pending = busyKey === `invitation:${invitation.invitationId}`;
                return (
                  <View key={invitation.invitationId} style={styles.inboxRow}>
                    <View style={styles.inboxIcon}>
                      <FontAwesome6 color={palette.accentDeep} name="envelope" size={14} />
                    </View>
                    <View style={styles.inboxCopy}>
                      <Text style={styles.memberName}>{invitation.businessName}</Text>
                      <Text style={styles.memberMeta}>
                        {roleLabel(invitation.role)} access
                        {invitation.invitedByDisplayName
                          ? ` · Invited by ${invitation.invitedByDisplayName}`
                          : ''}
                      </Text>
                      <Text style={styles.invitationExpiry}>
                        Expires {formatDate(invitation.expiresAt)}
                      </Text>
                    </View>
                    <View style={styles.inboxActions}>
                      <Pressable
                        accessibilityLabel={`Decline invitation from ${invitation.businessName}`}
                        accessibilityRole="button"
                        accessibilityState={{ busy: pending, disabled: Boolean(busyKey) }}
                        disabled={Boolean(busyKey)}
                        onPress={() => void respondToInvitation(invitation, 'decline')}
                        style={styles.quietButton}>
                        <Text style={styles.quietButtonText}>Decline</Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Accept invitation from ${invitation.businessName}`}
                        accessibilityRole="button"
                        accessibilityState={{ busy: pending, disabled: Boolean(busyKey) }}
                        disabled={Boolean(busyKey)}
                        onPress={() => void respondToInvitation(invitation, 'accept')}
                        style={[styles.compactPrimary, Boolean(busyKey) && styles.disabled]}>
                        {pending ? (
                          <ActivityIndicator color="#FFFFFF" size="small" />
                        ) : (
                          <Text style={styles.compactPrimaryText}>Accept</Text>
                        )}
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {inboxError ? (
            <View style={styles.inlineNotice}>
              <FontAwesome6
                color={palette.warning}
                name="triangle-exclamation"
                size={12}
              />
              <Text style={styles.inlineNoticeText}>{inboxError}</Text>
            </View>
          ) : null}

          {loading ? (
            <View accessibilityLiveRegion="polite" style={styles.loading}>
              <ActivityIndicator color={palette.accentDeep} size="small" />
              <Text style={styles.loadingText}>Loading protected team access…</Text>
            </View>
          ) : loadError || !team ? (
            <View style={styles.loadFailure}>
              <View style={styles.gateIcon}>
                <FontAwesome6 color={palette.accentDeep} name="user-lock" size={20} />
              </View>
              <Text accessibilityRole="header" style={styles.loadFailureTitle}>
                Team administration is unavailable.
              </Text>
              <Text style={styles.loadFailureBody}>
                {loadError ?? 'Owner or manager access could not be verified.'}
              </Text>
              <Pressable
                accessibilityLabel="Retry loading team access"
                accessibilityRole="button"
                onPress={() => void refresh()}
                style={styles.secondaryButton}>
                <FontAwesome6 color={palette.ink} name="rotate" size={12} />
                <Text style={styles.secondaryButtonText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.workspaceBar}>
                <View style={styles.workspaceIdentity}>
                  <View style={styles.workspaceIcon}>
                    <FontAwesome6 color="#FFFFFF" name="store" size={16} />
                  </View>
                  <View style={styles.workspaceCopy}>
                    <Text style={styles.workspaceName}>{team.businessName}</Text>
                    <Text style={styles.workspaceMeta}>
                      You are {team.viewerRole === 'owner' ? 'an owner' : 'a manager'} ·{' '}
                      {team.members.length} active{' '}
                      {team.members.length === 1 ? 'member' : 'members'}
                    </Text>
                  </View>
                </View>
                <Pressable
                  accessibilityLabel="Refresh team"
                  accessibilityRole="button"
                  accessibilityState={{ busy: loading, disabled: Boolean(busyKey) }}
                  disabled={Boolean(busyKey)}
                  onPress={() => void refresh(true)}
                  style={styles.iconButton}>
                  <FontAwesome6 color={palette.ink} name="rotate" size={13} />
                </Pressable>
              </View>

              <View style={[styles.columns, wide && styles.columnsWide]}>
                <View style={[styles.mainColumn, wide && styles.mainColumnWide]}>
                  <View style={styles.section}>
                    <View style={styles.sectionHeading}>
                      <View style={styles.sectionHeadingCopy}>
                        <Text style={styles.sectionEyebrow}>Current access</Text>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>
                          Members
                        </Text>
                      </View>
                      <View style={styles.countBadge}>
                        <Text style={styles.countBadgeText}>{team.members.length}</Text>
                      </View>
                    </View>

                    <View style={styles.memberList}>
                      {team.members.map((member) => {
                        const memberBusy = Boolean(
                          busyKey?.endsWith(member.memberPublicId)
                        );
                        const canEditRole =
                          !member.isCurrentUser &&
                          member.role !== 'owner' &&
                          team.viewerRole === 'owner';
                        const canRemove =
                          !member.isCurrentUser &&
                          (member.role === 'staff'
                            ? capabilities?.canRevokeStaff
                            : member.role === 'manager'
                              ? capabilities?.canRevokeManagers
                              : false);
                        return (
                          <View key={member.memberPublicId} style={styles.memberRow}>
                            <View style={styles.avatar}>
                              <Text style={styles.avatarText}>
                                {initials(member.displayName)}
                              </Text>
                            </View>
                            <View style={styles.memberCopy}>
                              <View style={styles.memberNameRow}>
                                <Text style={styles.memberName}>{member.displayName}</Text>
                                {member.isCurrentUser ? (
                                  <Text style={styles.youLabel}>You</Text>
                                ) : null}
                              </View>
                              <Text style={styles.memberMeta}>
                                @{member.username} · Joined {formatDate(member.joinedAt)}
                              </Text>
                              <View style={styles.roleSummary}>
                                <View
                                  style={[
                                    styles.roleBadge,
                                    member.role === 'owner' && styles.roleBadgeOwner,
                                  ]}>
                                  <FontAwesome6
                                    color={
                                      member.role === 'owner'
                                        ? palette.warning
                                        : palette.muted
                                    }
                                    name={member.role === 'owner' ? 'crown' : 'user-shield'}
                                    size={9}
                                  />
                                  <Text
                                    style={[
                                      styles.roleBadgeText,
                                      member.role === 'owner' &&
                                        styles.roleBadgeOwnerText,
                                    ]}>
                                    {roleLabel(member.role)}
                                  </Text>
                                </View>
                              </View>
                            </View>

                            {memberBusy ? (
                              <View style={styles.memberBusy}>
                                <ActivityIndicator color={palette.accentDeep} size="small" />
                              </View>
                            ) : canEditRole || canRemove ? (
                              <View style={styles.memberActions}>
                                {canEditRole ? (
                                  <View
                                    accessibilityLabel={`Role for ${member.displayName}`}
                                    accessibilityRole="radiogroup"
                                    style={styles.roleChoices}>
                                    {(['manager', 'staff'] as const).map((role) => {
                                      const selected = member.role === role;
                                      return (
                                        <Pressable
                                          accessibilityLabel={`${roleLabel(role)} role`}
                                          accessibilityRole="radio"
                                          accessibilityState={{
                                            checked: selected,
                                            disabled: Boolean(busyKey),
                                          }}
                                          disabled={selected || Boolean(busyKey)}
                                          key={role}
                                          onPress={() => void changeRole(member, role)}
                                          style={[
                                            styles.roleChoice,
                                            selected && styles.roleChoiceSelected,
                                          ]}>
                                          <Text
                                            style={[
                                              styles.roleChoiceText,
                                              selected && styles.roleChoiceTextSelected,
                                            ]}>
                                            {roleLabel(role)}
                                          </Text>
                                        </Pressable>
                                      );
                                    })}
                                  </View>
                                ) : null}
                                {canRemove ? (
                                  <Pressable
                                    accessibilityLabel={`Remove ${member.displayName}'s access`}
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: Boolean(busyKey) }}
                                    disabled={Boolean(busyKey)}
                                    onPress={() => void removeMember(member)}
                                    style={styles.removeButton}>
                                    <FontAwesome6
                                      color={palette.accentDeep}
                                      name="user-minus"
                                      size={11}
                                    />
                                    <Text style={styles.removeButtonText}>Remove</Text>
                                  </Pressable>
                                ) : null}
                                {capabilities?.canTransferOwnership &&
                                !member.isCurrentUser &&
                                member.role !== 'owner' ? (
                                  <Pressable
                                    accessibilityLabel={`Transfer ownership to ${member.displayName}`}
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: Boolean(busyKey) }}
                                    disabled={Boolean(busyKey)}
                                    onPress={() => void transferOwnership(member)}
                                    style={styles.transferButton}>
                                    <FontAwesome6
                                      color={palette.warning}
                                      name="arrow-right-arrow-left"
                                      size={10}
                                    />
                                    <Text style={styles.transferButtonText}>
                                      Transfer ownership
                                    </Text>
                                  </Pressable>
                                ) : null}
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.section}>
                    <View style={styles.sectionHeading}>
                      <View style={styles.sectionHeadingCopy}>
                        <Text style={styles.sectionEyebrow}>Activity</Text>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>
                          Invitations
                        </Text>
                      </View>
                    </View>
                    {team.invitations.length ? (
                      <View style={styles.invitationList}>
                        {team.invitations.map((invitation) => {
                          const canCancel =
                            invitation.state === 'pending' &&
                            (team.viewerRole === 'owner' ||
                              (team.viewerRole === 'manager' &&
                                invitation.role === 'staff'));
                          const pending =
                            busyKey === `revoke-invite:${invitation.invitationId}`;
                          return (
                            <View
                              key={invitation.invitationId}
                              style={styles.invitationRow}>
                              <View style={styles.invitationIcon}>
                                <FontAwesome6
                                  color={palette.muted}
                                  name={
                                    invitation.targetType === 'email'
                                      ? 'envelope'
                                      : 'at'
                                  }
                                  size={12}
                                />
                              </View>
                              <View style={styles.invitationCopy}>
                                <Text style={styles.invitationTarget}>
                                  {invitation.targetHint}
                                </Text>
                                <Text style={styles.memberMeta}>
                                  {roleLabel(invitation.role)} · Invited{' '}
                                  {formatDate(invitation.invitedAt)}
                                </Text>
                              </View>
                              <View
                                style={[
                                  styles.stateBadge,
                                  invitation.state === 'pending' &&
                                    styles.stateBadgePending,
                                ]}>
                                <Text
                                  style={[
                                    styles.stateBadgeText,
                                    invitation.state === 'pending' &&
                                      styles.stateBadgePendingText,
                                  ]}>
                                  {invitationStateLabel(invitation.state)}
                                </Text>
                              </View>
                              {canCancel ? (
                                <Pressable
                                  accessibilityLabel={`Cancel invitation for ${invitation.targetHint}`}
                                  accessibilityRole="button"
                                  accessibilityState={{
                                    busy: pending,
                                    disabled: Boolean(busyKey),
                                  }}
                                  disabled={Boolean(busyKey)}
                                  onPress={() =>
                                    void cancelBusinessInvitation(invitation)
                                  }
                                  style={styles.cancelInvitationButton}>
                                  {pending ? (
                                    <ActivityIndicator
                                      color={palette.accentDeep}
                                      size="small"
                                    />
                                  ) : (
                                    <Text style={styles.cancelInvitationText}>
                                      Cancel
                                    </Text>
                                  )}
                                </Pressable>
                              ) : null}
                            </View>
                          );
                        })}
                      </View>
                    ) : (
                      <View style={styles.emptyState}>
                        <FontAwesome6 color={palette.muted} name="envelope-open" size={16} />
                        <Text style={styles.emptyStateText}>
                          No recent invitations for this business.
                        </Text>
                      </View>
                    )}
                  </View>
                </View>

                <View style={[styles.sideColumn, wide && styles.sideColumnWide]}>
                  <View style={styles.invitePanel}>
                    <View style={styles.inviteIcon}>
                      <FontAwesome6 color={palette.accentDeep} name="user-plus" size={18} />
                    </View>
                    <Text accessibilityRole="header" style={styles.inviteTitle}>
                      Invite a teammate
                    </Text>
                    <Text style={styles.inviteBody}>
                      Use the email or username on their Spottr account. Spottr returns only a
                      masked hint and never exposes whether an email is registered.
                    </Text>

                    <View style={styles.field}>
                      <Text nativeID="invite-target-label" style={styles.fieldLabel}>
                        Email or username
                      </Text>
                      <TextInput
                        accessibilityLabelledBy="invite-target-label"
                        accessibilityState={{ disabled: Boolean(busyKey) }}
                        autoCapitalize="none"
                        autoComplete="email"
                        autoCorrect={false}
                        editable={!busyKey}
                        maxLength={254}
                        onChangeText={(value) => {
                          setInviteTarget(value);
                          inviteRequestKey.current = null;
                          setFeedback(null);
                        }}
                        placeholder="name@example.com or @username"
                        placeholderTextColor={palette.mutedLight}
                        returnKeyType="send"
                        onSubmitEditing={() => void sendInvitation()}
                        style={styles.input}
                        value={inviteTarget}
                      />
                    </View>

                    <View style={styles.field}>
                      <Text style={styles.fieldLabel}>Access level</Text>
                      <View
                        accessibilityLabel="Invitation role"
                        accessibilityRole="radiogroup"
                        style={styles.inviteRoleChoices}>
                        {(['staff', 'manager'] as const).map((role) => {
                          const allowed =
                            role === 'staff'
                              ? capabilities?.canInviteStaff
                              : capabilities?.canInviteManager;
                          const selected = inviteRole === role;
                          return (
                            <Pressable
                              accessibilityHint={roleDescriptions[role]}
                              accessibilityLabel={`${roleLabel(role)} role`}
                              accessibilityRole="radio"
                              accessibilityState={{
                                checked: selected,
                                disabled: !allowed || Boolean(busyKey),
                              }}
                              disabled={!allowed || Boolean(busyKey)}
                              key={role}
                              onPress={() => {
                                setInviteRole(role);
                                inviteRequestKey.current = null;
                                setFeedback(null);
                              }}
                              style={[
                                styles.inviteRoleChoice,
                                selected && styles.inviteRoleChoiceSelected,
                                !allowed && styles.disabled,
                              ]}>
                              <Text
                                style={[
                                  styles.inviteRoleTitle,
                                  selected && styles.inviteRoleTitleSelected,
                                ]}>
                                {roleLabel(role)}
                              </Text>
                              <Text
                                style={[
                                  styles.inviteRoleDescription,
                                  selected && styles.inviteRoleDescriptionSelected,
                                ]}>
                                {roleDescriptions[role]}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>

                    <Pressable
                      accessibilityLabel="Send team invitation"
                      accessibilityRole="button"
                      accessibilityState={{
                        busy: busyKey === 'invite',
                        disabled:
                          !inviteTarget.trim() ||
                          Boolean(busyKey) ||
                          (inviteRole === 'manager'
                            ? !capabilities?.canInviteManager
                            : !capabilities?.canInviteStaff),
                      }}
                      disabled={
                        !inviteTarget.trim() ||
                        Boolean(busyKey) ||
                        (inviteRole === 'manager'
                          ? !capabilities?.canInviteManager
                          : !capabilities?.canInviteStaff)
                      }
                      onPress={() => void sendInvitation()}
                      style={[
                        styles.primaryButton,
                        (!inviteTarget.trim() || Boolean(busyKey)) && styles.disabled,
                      ]}>
                      {busyKey === 'invite' ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                        <>
                          <FontAwesome6 color="#FFFFFF" name="paper-plane" size={12} />
                          <Text style={styles.primaryButtonText}>Send invitation</Text>
                        </>
                      )}
                    </Pressable>
                  </View>

                  <View style={styles.roleGuide}>
                    <Text style={styles.roleGuideTitle}>Role boundaries</Text>
                    <View style={styles.roleGuideRow}>
                      <FontAwesome6 color={palette.warning} name="crown" size={11} />
                      <View style={styles.roleGuideCopy}>
                        <Text style={styles.roleGuideName}>Owner</Text>
                        <Text style={styles.roleGuideDescription}>
                          Full team control, including roles and ownership transfer.
                        </Text>
                      </View>
                    </View>
                    <View style={styles.roleGuideRow}>
                      <FontAwesome6 color={palette.muted} name="user-shield" size={11} />
                      <View style={styles.roleGuideCopy}>
                        <Text style={styles.roleGuideName}>Manager</Text>
                        <Text style={styles.roleGuideDescription}>
                          Runs operations and can manage staff, but not owners or managers.
                        </Text>
                      </View>
                    </View>
                    <View style={styles.roleGuideRow}>
                      <FontAwesome6 color={palette.muted} name="user" size={11} />
                      <View style={styles.roleGuideCopy}>
                        <Text style={styles.roleGuideName}>Staff</Text>
                        <Text style={styles.roleGuideDescription}>
                          Can view the managed workspace, with no team-administration
                          privileges.
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.auditNote}>
                    <FontAwesome6 color={palette.success} name="shield-halved" size={13} />
                    <Text style={styles.auditNoteText}>
                      Team changes are authorized on the server with a current authenticator
                      session and recorded in Spottr’s security audit trail.
                    </Text>
                  </View>
                </View>
              </View>
            </>
          )}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    paddingBottom: 96,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  topbarStart: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  topbarSpacer: {
    width: 44,
  },
  iconButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  securityBadge: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 7,
    minHeight: 36,
    paddingHorizontal: 12,
  },
  securityBadgeText: {
    color: palette.success,
    fontSize: 11,
    fontWeight: '900',
  },
  heading: {
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    gap: spacing.sm,
    paddingBottom: spacing.xl,
    paddingTop: spacing.xl,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 40,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 44,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 620,
  },
  feedback: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  feedbackSuccess: {
    backgroundColor: palette.successSoft,
  },
  feedbackText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  feedbackTextSuccess: {
    color: palette.success,
  },
  inboxSection: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginTop: spacing.lg,
    overflow: 'hidden',
  },
  sectionHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  sectionHeadingCopy: {
    gap: 4,
  },
  sectionEyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  countBadge: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    minWidth: 32,
    paddingHorizontal: 8,
  },
  countBadgeText: {
    color: palette.ink,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '800',
  },
  inboxRow: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    minHeight: 76,
    padding: spacing.md,
  },
  inboxIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  inboxCopy: {
    flex: 1,
    gap: 3,
    minWidth: 180,
  },
  inboxActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  invitationExpiry: {
    color: palette.muted,
    fontSize: 11,
  },
  quietButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  quietButtonText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  compactPrimary: {
    alignItems: 'center',
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 82,
    paddingHorizontal: 14,
  },
  compactPrimaryText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  inlineNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  inlineNoticeText: {
    color: palette.warning,
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
  },
  loading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 240,
  },
  loadingText: {
    color: palette.muted,
    fontSize: 12,
  },
  loadFailure: {
    alignItems: 'flex-start',
    alignSelf: 'center',
    gap: spacing.md,
    marginTop: spacing.xxl,
    maxWidth: 620,
    width: '100%',
  },
  loadFailureTitle: {
    color: palette.ink,
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: -1,
  },
  loadFailureBody: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  workspaceBar: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
  },
  workspaceIdentity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  workspaceIcon: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.md,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  workspaceCopy: {
    flexShrink: 1,
    gap: 3,
  },
  workspaceName: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  workspaceMeta: {
    color: palette.muted,
    fontSize: 11,
  },
  columns: {
    gap: spacing.lg,
    paddingTop: spacing.xl,
  },
  columnsWide: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  mainColumn: {
    gap: spacing.lg,
  },
  mainColumnWide: {
    flex: 1,
  },
  sideColumn: {
    gap: spacing.lg,
  },
  sideColumnWide: {
    width: 380,
  },
  section: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  memberList: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
  },
  memberRow: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    minHeight: 88,
    padding: spacing.md,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: palette.dark,
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  memberCopy: {
    flex: 1,
    gap: 3,
    minWidth: 190,
  },
  memberNameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  memberName: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  youLabel: {
    color: palette.success,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  memberMeta: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  roleSummary: {
    alignItems: 'flex-start',
    marginTop: 4,
  },
  roleBadge: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 5,
    minHeight: 24,
    paddingHorizontal: 8,
  },
  roleBadgeOwner: {
    backgroundColor: palette.warningSoft,
  },
  roleBadgeText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  roleBadgeOwnerText: {
    color: palette.warning,
  },
  memberActions: {
    alignItems: 'flex-end',
    gap: 7,
  },
  memberBusy: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  roleChoices: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  roleChoice: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 76,
    paddingHorizontal: 12,
  },
  roleChoiceSelected: {
    backgroundColor: palette.ink,
  },
  roleChoiceText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  roleChoiceTextSelected: {
    color: '#FFFFFF',
  },
  removeButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 10,
  },
  removeButtonText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  transferButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 10,
  },
  transferButtonText: {
    color: palette.warning,
    fontSize: 11,
    fontWeight: '900',
  },
  invitationList: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
  },
  invitationRow: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    minHeight: 64,
    padding: spacing.md,
  },
  invitationIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  invitationCopy: {
    flex: 1,
    gap: 3,
    minWidth: 150,
  },
  invitationTarget: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  stateBadge: {
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  stateBadgePending: {
    backgroundColor: palette.warningSoft,
  },
  stateBadgeText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  stateBadgePendingText: {
    color: palette.warning,
  },
  cancelInvitationButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 56,
    paddingHorizontal: 8,
  },
  cancelInvitationText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  emptyState: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 80,
    padding: spacing.lg,
  },
  emptyStateText: {
    color: palette.muted,
    fontSize: 11,
  },
  invitePanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  inviteIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  inviteTitle: {
    color: palette.ink,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  inviteBody: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  field: {
    gap: 7,
  },
  fieldLabel: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 12,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  inviteRoleChoices: {
    gap: spacing.sm,
  },
  inviteRoleChoice: {
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 4,
    minHeight: 64,
    padding: spacing.sm,
  },
  inviteRoleChoiceSelected: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  inviteRoleTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  inviteRoleTitleSelected: {
    color: '#FFFFFF',
  },
  inviteRoleDescription: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  inviteRoleDescriptionSelected: {
    color: palette.darkMuted,
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  roleGuide: {
    borderBottomColor: palette.line,
    borderTopColor: palette.line,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  roleGuideTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  roleGuideRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  roleGuideCopy: {
    flex: 1,
    gap: 3,
  },
  roleGuideName: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  roleGuideDescription: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  auditNote: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  auditNoteText: {
    color: palette.success,
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 17,
  },
  gate: {
    alignItems: 'flex-start',
    alignSelf: 'center',
    gap: spacing.lg,
    marginTop: spacing.xxxl,
    maxWidth: 620,
    width: '100%',
  },
  gateIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.lg,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  gateTitle: {
    color: palette.ink,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -1.2,
    lineHeight: 34,
  },
  gateBody: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  disabled: {
    opacity: 0.55,
  },
});
