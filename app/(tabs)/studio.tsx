import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Link, router } from 'expo-router';
import type { Href } from 'expo-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { OwnerUpdate } from '@/components/owner-update';
import { PageShell } from '@/components/page-shell';
import { SectionHeading } from '@/components/section-heading';
import { ShadowOrderQueue } from '@/components/shadow-order-queue';
import { StatusPill } from '@/components/status-pill';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import {
  businessDateAfter,
  cancelPublishedMobileStop,
  createPublishedMobileStop,
  loadPublishedMobileSchedule,
  PublishedMobileSchedule,
  PublishedMobileStop,
  schedulePublishedMobileStop,
} from '@/lib/business-management';
import {
  BUSINESS_RESPONSE_MAX_LENGTH,
  BusinessResponseAttempt,
  BusinessResponseRecord,
  loadBusinessResponseQueue,
  prepareBusinessResponseAttempt,
  submitBusinessResponse,
} from '@/lib/business-responses';
import { featureFlags } from '@/lib/features';
import {
  createMarketplaceIdempotencyKey,
  setMenuItemAvailability,
} from '@/lib/marketplace-api';
import { confirmAction } from '@/lib/platform-dialog';
import { BusinessUpdate, Review, VenueStatus } from '@/types/marketplace';

const updateTypes: { id: BusinessUpdate['type']; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'availability', label: 'Sold out / available', icon: 'utensils' },
  { id: 'location', label: 'Location', icon: 'location-arrow' },
  { id: 'hours', label: 'Hours', icon: 'clock' },
  { id: 'menu', label: 'Menu', icon: 'receipt' },
];

const quickStatuses: { id: VenueStatus; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'open', label: 'Go live', icon: 'signal' },
  { id: 'moving_soon', label: 'Moving soon', icon: 'truck-fast' },
  { id: 'closed', label: 'Close early', icon: 'door-closed' },
];

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

type StudioFeedback = { type: 'error' | 'success'; text: string };
type StudioWriteSession = { scope: string };
type StudioWriteToken = {
  accountId: string;
  businessId: string;
  busyKey: string;
  lane: string;
  session: StudioWriteSession;
  scope: string;
};

export default function StudioScreen() {
  const auth = useAuth();
  const accountId =
    auth.status === 'authenticated' && auth.account?.id ? auth.account.id : null;
  const { managedPlaceIds, places, publishUpdate, setVenueStatus } = useMarketplaceStore();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const managedPlaces = useMemo(
    () => places.filter((entry) => managedPlaceIds.includes(entry.id)),
    [managedPlaceIds, places]
  );
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const place =
    managedPlaces.find((entry) => entry.id === selectedPlaceId) ??
    managedPlaces[0];
  const studioWriteScope =
    accountId &&
    place &&
    auth.securityStatus === 'ready' &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === 'aal2'
      ? `account:${accountId}:business:${place.id}:aal2`
      : null;
  const studioWriteSession = useMemo<StudioWriteSession | null>(
    () => (studioWriteScope ? { scope: studioWriteScope } : null),
    [studioWriteScope]
  );
  const studioWriteSessionRef = useRef<StudioWriteSession | null>(
    studioWriteSession
  );
  const studioWriteBusy = useRef(new Set<string>());
  const [ownerUpdateDraft, setOwnerUpdateDraft] = useState<{
    scope: string | null;
    message: string;
    type: BusinessUpdate['type'];
  }>({ scope: null, message: '', type: 'availability' });
  const message =
    ownerUpdateDraft.scope === studioWriteScope ? ownerUpdateDraft.message : '';
  const updateType =
    ownerUpdateDraft.scope === studioWriteScope
      ? ownerUpdateDraft.type
      : 'availability';
  const setMessage = (nextMessage: string) => {
    if (!studioWriteScope) return;
    setOwnerUpdateDraft((current) => ({
      scope: studioWriteScope,
      message: nextMessage,
      type: current.scope === studioWriteScope ? current.type : 'availability',
    }));
  };
  const setUpdateType = (nextType: BusinessUpdate['type']) => {
    if (!studioWriteScope) return;
    setOwnerUpdateDraft((current) => ({
      scope: studioWriteScope,
      message: current.scope === studioWriteScope ? current.message : '',
      type: nextType,
    }));
  };
  const [soldOutState, setSoldOutState] = useState<{
    session: StudioWriteSession | null;
    ids: string[];
  }>({ session: null, ids: [] });
  const [publishingSession, setPublishingSession] =
    useState<StudioWriteSession | null>(null);
  const publishing = Boolean(
    studioWriteSession && publishingSession === studioWriteSession
  );
  const [statusPendingState, setStatusPendingState] = useState<{
    session: StudioWriteSession;
    status: VenueStatus;
  } | null>(null);
  const statusPending =
    statusPendingState?.session === studioWriteSession
      ? statusPendingState.status
      : null;
  const [menuPendingState, setMenuPendingState] = useState<{
    session: StudioWriteSession;
    ids: string[];
  } | null>(null);
  const menuPendingIds =
    menuPendingState?.session === studioWriteSession
      ? menuPendingState.ids
      : [];
  const scheduleScope = accountId && place ? `${accountId}:${place.id}` : null;
  const [mobileScheduleSnapshot, setMobileScheduleSnapshot] = useState<{
    scope: string;
    data: PublishedMobileSchedule;
  } | null>(null);
  const mobileSchedule =
    scheduleScope && mobileScheduleSnapshot?.scope === scheduleScope
      ? mobileScheduleSnapshot.data
      : null;
  const [stopEditor, setStopEditor] = useState<PublishedMobileStop | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const scheduleRequest = useRef(0);
  const scheduleMutationBusy = useRef(false);
  const studioMounted = useRef(true);
  const scheduleAccountId = useRef<string | null>(accountId);
  const scheduleScopeRef = useRef<string | null>(scheduleScope);
  const loadedScheduleScope = useRef<string | null>(null);
  const responseQueueRequest = useRef(0);
  const responseAttempts = useRef<Record<string, BusinessResponseAttempt>>({});
  const ownerUpdateAttempts = useRef(new Map<string, string>());
  const [responseQueue, setResponseQueue] = useState<{
    session: StudioWriteSession | null;
    businessId: string | null;
    loading: boolean;
    records: BusinessResponseRecord[];
    error: string | null;
  }>({
    session: null,
    businessId: null,
    loading: false,
    records: [],
    error: null,
  });
  const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
  const [responseOverrides, setResponseOverrides] = useState<
    Record<string, { scope: string; record: BusinessResponseRecord }>
  >({});
  const [responseSavingState, setResponseSavingState] = useState<{
    session: StudioWriteSession;
    reviewId: string;
  } | null>(null);
  const responseSavingId =
    responseSavingState?.session === studioWriteSession
      ? responseSavingState.reviewId
      : null;
  const [feedbackState, setFeedbackState] = useState<{
    session: StudioWriteSession;
    value: StudioFeedback;
  } | null>(null);
  const feedback =
    feedbackState?.session === studioWriteSession
      ? feedbackState.value
      : null;
  const setFeedback = (next: StudioFeedback | null) => {
    setFeedbackState(
      next && studioWriteSession
        ? { session: studioWriteSession, value: next }
        : null
    );
  };
  const canOperate = !place?.publicationState || place.publicationState === 'published';
  const needsSetup = place?.publicationState === 'draft';
  const publishedMobile =
    place?.publicationState === 'published' &&
    (place.category === 'food_truck' || place.category === 'pop_up');
  const sourceSoldOutIds = useMemo(
    () =>
      place
        ? place.menu.flatMap((section) =>
            section.items.filter((item) => item.soldOut).map((item) => item.id)
          )
        : [],
    [place]
  );
  const soldOutIds =
    studioWriteSession && soldOutState.session === studioWriteSession
      ? soldOutState.ids
      : sourceSoldOutIds;
  const queuedResponses = useMemo(() => {
    const mapped = new Map<string, BusinessResponseRecord>();
    if (
      studioWriteScope &&
      responseQueue.session === studioWriteSession &&
      responseQueue.businessId === place?.id
    ) {
      for (const record of responseQueue.records) mapped.set(record.reviewId, record);
    }
    for (const override of Object.values(responseOverrides)) {
      if (
        override.scope === studioWriteScope &&
        override.record.businessId === place?.id
      ) {
        mapped.set(override.record.reviewId, override.record);
      }
    }
    return mapped;
  }, [
    place?.id,
    responseOverrides,
    responseQueue,
    studioWriteSession,
    studioWriteScope,
  ]);

  useEffect(() => {
    studioMounted.current = true;
    return () => {
      studioMounted.current = false;
      scheduleMutationBusy.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    scheduleAccountId.current = accountId;
    scheduleScopeRef.current = scheduleScope;
  }, [accountId, scheduleScope]);

  useLayoutEffect(() => {
    studioWriteSessionRef.current = studioWriteSession;
  }, [studioWriteSession]);

  const beginStudioWrite = (lane: string): StudioWriteToken | null => {
    if (
      !accountId ||
      !place ||
      !studioWriteScope ||
      !studioWriteSession ||
      studioWriteSessionRef.current !== studioWriteSession ||
      studioWriteBusy.current.has(`${studioWriteScope}:${lane}`)
    ) {
      return null;
    }
    const busyKey = `${studioWriteScope}:${lane}`;
    studioWriteBusy.current.add(busyKey);
    return {
      accountId,
      businessId: place.id,
      busyKey,
      lane,
      session: studioWriteSession,
      scope: studioWriteScope,
    };
  };

  const isCurrentStudioWrite = (token: StudioWriteToken) =>
    studioMounted.current &&
    studioWriteSessionRef.current === token.session;

  const finishStudioWrite = (token: StudioWriteToken) => {
    studioWriteBusy.current.delete(token.busyKey);
    return isCurrentStudioWrite(token);
  };

  const setItemSoldOut = (itemId: string, soldOut: boolean) => {
    if (!place || !studioWriteSession) return;
    setSoldOutState((current) => {
      const currentIds =
        current.session === studioWriteSession
          ? current.ids
          : sourceSoldOutIds;
      return {
        session: studioWriteSession,
        ids: soldOut
          ? [...new Set([...currentIds, itemId])]
          : currentIds.filter((entry) => entry !== itemId),
      };
    });
  };

  const refreshMobileSchedule = useCallback(async () => {
    const request = scheduleRequest.current + 1;
    scheduleRequest.current = request;
    if (
      !place ||
      !publishedMobile ||
      !accountId ||
      !scheduleScope ||
      !auth.isConfigured ||
      auth.securityStatus !== 'ready' ||
      !auth.mfaEnrolled ||
      auth.assuranceLevel !== 'aal2'
    ) {
      loadedScheduleScope.current = null;
      setMobileScheduleSnapshot(null);
      setStopEditor(null);
      setScheduleError(null);
      setScheduleLoading(false);
      return;
    }
    setScheduleLoading(true);
    setScheduleError(null);
    const result = await loadPublishedMobileSchedule(place.id, accountId);
    if (
      scheduleRequest.current !== request ||
      scheduleAccountId.current !== accountId ||
      scheduleScopeRef.current !== scheduleScope
    ) {
      return;
    }
    setScheduleLoading(false);
    if (!result.ok) {
      loadedScheduleScope.current = null;
      setMobileScheduleSnapshot(null);
      setScheduleError(result.reason);
      return;
    }
    if (loadedScheduleScope.current !== scheduleScope) setStopEditor(null);
    loadedScheduleScope.current = scheduleScope;
    setMobileScheduleSnapshot({ scope: scheduleScope, data: result.data });
  }, [
    auth.assuranceLevel,
    auth.isConfigured,
    auth.mfaEnrolled,
    auth.securityStatus,
    accountId,
    place,
    publishedMobile,
    scheduleScope,
    setScheduleError,
    setStopEditor,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshMobileSchedule();
    }, 0);
    return () => {
      clearTimeout(timer);
      scheduleRequest.current += 1;
    };
  }, [refreshMobileSchedule]);

  useEffect(() => {
    scheduleRequest.current += 1;
    loadedScheduleScope.current = null;
    scheduleMutationBusy.current = false;
    const timer = setTimeout(() => {
      if (!studioMounted.current || scheduleScopeRef.current !== scheduleScope) return;
      setMobileScheduleSnapshot(null);
      setStopEditor(null);
      setScheduleError(null);
      setScheduleLoading(false);
      setScheduleSaving(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [scheduleScope]);

  const refreshResponseQueue = useCallback(async () => {
    const request = responseQueueRequest.current + 1;
    responseQueueRequest.current = request;
    const requestSession = studioWriteSession;
    const businessId = place?.id;
    if (
      !businessId ||
      !accountId ||
      !studioWriteScope ||
      !requestSession ||
      !canOperate ||
      !auth.isConfigured ||
      auth.status !== 'authenticated' ||
      auth.securityStatus !== 'ready' ||
      !auth.mfaEnrolled ||
      auth.assuranceLevel !== 'aal2'
    ) {
      setResponseQueue({
        session: requestSession,
        businessId: businessId ?? null,
        loading: false,
        records: [],
        error: null,
      });
      return;
    }

    setResponseQueue({
      session: requestSession,
      businessId,
      loading: true,
      records: [],
      error: null,
    });
    const result = await loadBusinessResponseQueue(businessId, accountId);
    if (
      !studioMounted.current ||
      responseQueueRequest.current !== request ||
      studioWriteSessionRef.current !== requestSession
    ) {
      return;
    }
    setResponseQueue(
      result.ok
        ? {
            session: requestSession,
            businessId,
            loading: false,
            records: result.data,
            error: null,
          }
        : {
            session: requestSession,
            businessId,
            loading: false,
            records: [],
            error: result.reason,
          }
    );
  }, [
    auth.assuranceLevel,
    auth.isConfigured,
    auth.mfaEnrolled,
    auth.securityStatus,
    auth.status,
    accountId,
    canOperate,
    place?.id,
    studioWriteSession,
    studioWriteScope,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshResponseQueue();
    }, 0);
    return () => {
      clearTimeout(timer);
      responseQueueRequest.current += 1;
    };
  }, [refreshResponseQueue]);

  const beginNewStop = () => {
    if (!mobileSchedule?.locations.length || scheduleMutationBusy.current) return;
    const serviceDate = businessDateAfter(mobileSchedule.business.timezone, 1);
    setStopEditor(
      createPublishedMobileStop(mobileSchedule.locations[0].id!, serviceDate)
    );
    setScheduleError(null);
  };

  const saveScheduledStop = async () => {
    if (
      !place ||
      !stopEditor ||
      !accountId ||
      !scheduleScope ||
      scheduleMutationBusy.current
    ) {
      return;
    }
    const initiatingAccountId = accountId;
    const initiatingScheduleScope = scheduleScope;
    scheduleMutationBusy.current = true;
    setScheduleSaving(true);
    setScheduleError(null);
    const result = await schedulePublishedMobileStop(
      place.id,
      stopEditor,
      initiatingAccountId
    );
    if (
      !studioMounted.current ||
      scheduleAccountId.current !== initiatingAccountId ||
      scheduleScopeRef.current !== initiatingScheduleScope
    ) {
      return;
    }
    scheduleMutationBusy.current = false;
    setScheduleSaving(false);
    if (!result.ok) {
      setScheduleError(result.reason);
      return;
    }
    setStopEditor(null);
    setFeedback({
      type: 'success',
      text: result.message ?? 'Upcoming stop scheduled.',
    });
    await refreshMobileSchedule();
  };

  const cancelScheduledStop = async () => {
    if (
      !place ||
      !stopEditor?.id ||
      !accountId ||
      !scheduleScope ||
      scheduleMutationBusy.current
    ) {
      return;
    }
    const initiatingAccountId = accountId;
    const initiatingScheduleScope = scheduleScope;
    scheduleMutationBusy.current = true;
    const confirmed = await confirmAction({
      title: 'Cancel this upcoming stop?',
      message: 'Customers will no longer see this stop in the upcoming schedule.',
      confirmLabel: 'Cancel stop',
      destructive: true,
    });
    if (
      !studioMounted.current ||
      scheduleAccountId.current !== initiatingAccountId ||
      scheduleScopeRef.current !== initiatingScheduleScope
    ) {
      return;
    }
    if (!confirmed) {
      scheduleMutationBusy.current = false;
      return;
    }
    setScheduleSaving(true);
    setScheduleError(null);
    const result = await cancelPublishedMobileStop(
      place.id,
      stopEditor.id,
      initiatingAccountId
    );
    if (
      !studioMounted.current ||
      scheduleAccountId.current !== initiatingAccountId ||
      scheduleScopeRef.current !== initiatingScheduleScope
    ) {
      return;
    }
    scheduleMutationBusy.current = false;
    setScheduleSaving(false);
    if (!result.ok) {
      setScheduleError(result.reason);
      return;
    }
    setStopEditor(null);
    setFeedback({
      type: 'success',
      text: result.message ?? 'Upcoming stop cancelled.',
    });
    await refreshMobileSchedule();
  };

  const publish = async () => {
    if (!place || publishing || !canOperate) return;
    const token = beginStudioWrite('owner-update');
    if (!token) return;
    const fingerprint = `${token.scope}\u0000${updateType}\u0000${message}`;
    const idempotencyKey =
      ownerUpdateAttempts.current.get(fingerprint) ??
      createMarketplaceIdempotencyKey('update');
    ownerUpdateAttempts.current.set(fingerprint, idempotencyKey);
    setPublishingSession(token.session);
    setFeedback(null);
    const result = await publishUpdate({
      placeId: token.businessId,
      type: updateType,
      message,
      idempotencyKey,
    });
    if (!finishStudioWrite(token)) return;
    setPublishingSession(null);
    if (!result.ok) {
      setFeedback({ type: 'error', text: result.reason });
      return;
    }

    ownerUpdateAttempts.current.delete(fingerprint);
    setMessage('');
    setFeedback({
      type: 'success',
      text: result.message ?? 'Update published. Followers can see it now.',
    });
  };

  const submitReviewResponse = async (review: Review) => {
    if (!place || !studioWriteScope || responseSavingId || !canOperate) return;
    const draftKey = `${studioWriteScope}:${review.id}`;
    const existing =
      queuedResponses.get(review.id)?.body ?? review.ownerResponse ?? '';
    const body = responseDrafts[draftKey] ?? existing;
    let attempt: BusinessResponseAttempt;
    try {
      attempt = prepareBusinessResponseAttempt(
        responseAttempts.current[draftKey],
        review.id,
        body
      );
    } catch (error) {
      setFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : 'Check this response and try again.',
      });
      return;
    }

    const token = beginStudioWrite('review-response');
    if (!token) return;
    responseAttempts.current[draftKey] = attempt;
    setResponseSavingState({
      session: token.session,
      reviewId: review.id,
    });
    setFeedback(null);
    const result = await submitBusinessResponse(
      token.businessId,
      attempt,
      token.accountId
    );
    if (!finishStudioWrite(token)) return;
    setResponseSavingState(null);
    if (!result.ok) {
      setFeedback({ type: 'error', text: result.reason });
      return;
    }

    delete responseAttempts.current[draftKey];
    setResponseOverrides((current) => ({
      ...current,
      [draftKey]: { scope: token.scope, record: result.data },
    }));
    setResponseDrafts((current) => ({
      ...current,
      [draftKey]: result.data.body,
    }));
    setFeedback({
      type: 'success',
      text:
        result.data.moderationState === 'approved'
          ? `Your response to ${review.displayName} is public.`
          : `Your response to ${review.displayName} is queued for a safety review.`,
    });
  };

  const applyStatus = async (
    status: VenueStatus,
    token: StudioWriteToken
  ) => {
    setFeedback(null);
    const result = await setVenueStatus(token.businessId, status);
    if (!finishStudioWrite(token)) return;
    setStatusPendingState(null);
    if (!result.ok) {
      setFeedback({ type: 'error', text: result.reason });
      return;
    }
    setFeedback({ type: 'success', text: 'Live service status updated.' });
  };

  const changeStatus = async (status: VenueStatus) => {
    if (!place || statusPending || !canOperate) return;
    const token = beginStudioWrite('venue-status');
    if (!token) return;
    setStatusPendingState({ session: token.session, status });
    if (status === 'closed' && place?.status !== 'closed') {
      const confirmed = await confirmAction({
        title: 'Close service early?',
        message: 'Customers will immediately see this business as closed.',
        confirmLabel: 'Close service',
        destructive: true,
      });
      if (!isCurrentStudioWrite(token)) {
        finishStudioWrite(token);
        return;
      }
      if (!confirmed) {
        finishStudioWrite(token);
        setStatusPendingState(null);
        return;
      }
    }
    if (!isCurrentStudioWrite(token)) {
      finishStudioWrite(token);
      return;
    }
    await applyStatus(status, token);
  };

  const toggleSoldOut = async (id: string) => {
    if (menuPendingIds.includes(id) || !canOperate) return;
    const token = beginStudioWrite(`menu-availability:${id}`);
    if (!token) return;
    const wasSoldOut = soldOutIds.includes(id);
    const nextSoldOut = !wasSoldOut;
    setMenuPendingState((current) => ({
      session: token.session,
      ids: [
        ...new Set([
          ...(current?.session === token.session ? current.ids : []),
          id,
        ]),
      ],
    }));
    setItemSoldOut(id, nextSoldOut);
    const result = await setMenuItemAvailability(
      id,
      nextSoldOut,
      token.accountId
    );
    if (!finishStudioWrite(token)) return;
    setMenuPendingState((current) =>
      current?.session === token.session
        ? { ...current, ids: current.ids.filter((item) => item !== id) }
        : current
    );
    if (!result.ok) {
      setItemSoldOut(id, wasSoldOut);
      setFeedback({ type: 'error', text: result.reason });
    } else {
      setFeedback({
        type: 'success',
        text: nextSoldOut ? 'Item marked sold out.' : 'Item marked available.',
      });
    }
  };

  if (
    auth.isConfigured &&
    auth.status === 'authenticated' &&
    managedPlaces.length > 0 &&
    (auth.securityStatus !== 'ready' || !auth.mfaEnrolled || auth.assuranceLevel !== 'aal2')
  ) {
    return (
      <FocusAwareScreen>
        <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
          <PageShell narrow>
            <View style={styles.topbar}>
              <BrandMark />
              <View style={styles.secureBadge}>
                <FontAwesome6 color={palette.accentDeep} name="lock" size={12} />
                <Text style={styles.secureText}>Verification required</Text>
              </View>
            </View>
            <View style={styles.accessGate}>
              <View style={styles.accessIcon}>
                <FontAwesome6 color={palette.accent} name="mobile-screen-button" size={24} />
              </View>
              <Text accessibilityRole="header" style={styles.accessTitle}>
                Protect this business workspace.
              </Text>
              <Text style={styles.accessBody}>
                Connect an authenticator and verify a current code before changing public business
                information, service status, or menu availability.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/security')}
                style={styles.accessPrimary}>
                <Text style={styles.accessPrimaryText}>Open security settings</Text>
              </Pressable>
            </View>
          </PageShell>
        </ScrollView>
      </FocusAwareScreen>
    );
  }

  if (!place) {
    const signedOut = auth.status === 'anonymous';
    return (
      <FocusAwareScreen>
        <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
          <PageShell narrow>
          <View style={styles.topbar}>
            <BrandMark />
            <View style={styles.secureBadge}>
              <FontAwesome6 color={palette.success} name="shield-halved" size={12} />
              <Text style={styles.secureText}>Protected workspace</Text>
            </View>
          </View>
          <View style={styles.accessGate}>
            <View style={styles.accessIcon}>
              <FontAwesome6 color={palette.accent} name="store" size={24} />
            </View>
            <Text accessibilityRole="header" style={styles.accessTitle}>
              {signedOut ? 'Sign in to manage a business.' : 'Add or claim your business.'}
            </Text>
            <Text style={styles.accessBody}>
              Studio opens only for active members of a managed business. Customer mode never
              grants business privileges.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(signedOut ? '/auth' : '/business-onboarding')}
              style={styles.accessPrimary}>
              <Text style={styles.accessPrimaryText}>{signedOut ? 'Sign in' : 'Add or claim a business'}</Text>
              <FontAwesome6 color="#FFFFFF" name="arrow-right" size={13} />
            </Pressable>
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
          <BrandMark />
          <View style={styles.secureBadge}>
            <FontAwesome6 color={palette.success} name="shield-halved" size={12} />
            <Text style={styles.secureText}>Owner access</Text>
          </View>
        </View>

        {managedPlaces.length > 1 ? (
          <ScrollView
            accessibilityLabel="Choose a managed business"
            contentContainerStyle={styles.businessSwitcher}
            horizontal
            showsHorizontalScrollIndicator={false}>
            {managedPlaces.map((business) => {
              const selected = business.id === place.id;
              return (
                <Pressable
                  accessibilityRole="radio"
                  aria-checked={selected}
                  accessibilityState={{ checked: selected }}
                  key={business.id}
                  onPress={() => {
                    setSelectedPlaceId(business.id);
                    setFeedback(null);
                  }}
                  style={[styles.businessSwitch, selected && styles.businessSwitchActive]}>
                  <Text
                    numberOfLines={1}
                    style={[styles.businessSwitchText, selected && styles.businessSwitchTextActive]}>
                    {business.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <View style={styles.businessHeader}>
          <View style={styles.businessIdentity}>
            <View style={styles.logoFallback}>
              <FontAwesome6
                color="#FFFFFF"
                name={place.category === 'food_truck' ? 'truck' : 'store'}
                size={20}
              />
            </View>
            <View style={styles.businessCopy}>
              <View style={styles.nameRow}>
                <Text accessibilityRole="header" style={styles.businessName}>{place.name}</Text>
                {place.verified ? (
                  <FontAwesome6 color={palette.success} name="circle-check" size={16} solid />
                ) : null}
              </View>
              <Text style={styles.businessMeta}>
                {place.categoryLabel} · Managed business ·{' '}
                {place.publicationState === 'pending'
                  ? 'Verification pending'
                  : place.publicationState === 'draft'
                    ? 'Private draft'
                    : 'Public listing'}
              </Text>
            </View>
          </View>
          {canOperate ? <StatusPill status={place.status} /> : null}
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Business studio</Text>
          <Text accessibilityRole="header" style={styles.title}>Run today’s service in a few taps.</Text>
          <Text style={styles.subtitle}>
            Keep your location, availability, menu, and payments accurate without posting across five different places.
          </Text>
        </View>

        {!canOperate ? (
          <View style={styles.reviewState}>
            <FontAwesome6
              color={palette.warning}
              name={needsSetup ? 'list-check' : 'clock-rotate-left'}
              size={16}
            />
            <View style={styles.reviewStateCopy}>
              <Text style={styles.reviewStateTitle}>
                {needsSetup ? 'Complete your private draft' : 'Verification is in progress'}
              </Text>
              <Text style={styles.reviewStateDetail}>
                {needsSetup
                  ? 'Add a private service pin, seven-day hours, accepted payments, and a menu before an owner submits the listing.'
                  : 'This listing stays private while identity, location, and eligibility checks are completed. Live controls unlock only after approval.'}
              </Text>
              {needsSetup ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/business-setup',
                      params: { businessId: place.id },
                    })
                  }
                  style={styles.setupButton}>
                  <Text style={styles.setupButtonText}>Continue business setup</Text>
                  <FontAwesome6 color="#FFFFFF" name="arrow-right" size={11} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        <View style={styles.quickActions}>
          {quickStatuses.map((action) => {
            const active = place.status === action.id;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{
                  busy: statusPending === action.id,
                  disabled: !canOperate,
                  selected: active,
                }}
                disabled={Boolean(statusPending) || !canOperate}
                key={action.id}
                onPress={() => void changeStatus(action.id)}
                style={[
                  styles.quickAction,
                  active && styles.quickActionActive,
                  !canOperate && styles.buttonDisabled,
                ]}>
                <View style={[styles.quickIcon, active && styles.quickIconActive]}>
                  {statusPending === action.id ? (
                    <ActivityIndicator color={active ? '#FFFFFF' : palette.ink} size="small" />
                  ) : (
                    <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={action.icon} size={15} />
                  )}
                </View>
                <Text style={[styles.quickLabel, active && styles.quickLabelActive]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {feedback ? (
          <View
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={[styles.feedback, feedback.type === 'success' && styles.feedbackSuccess]}>
            <FontAwesome6
              color={feedback.type === 'success' ? palette.success : palette.accentDeep}
              name={feedback.type === 'success' ? 'circle-check' : 'triangle-exclamation'}
              size={13}
              solid
            />
            <Text style={[styles.feedbackText, feedback.type === 'success' && styles.feedbackTextSuccess]}>
              {feedback.text}
            </Text>
          </View>
        ) : null}

        {featureFlags.pickupOrdering && canOperate ? (
          <ShadowOrderQueue businessId={place.id} key={place.id} />
        ) : null}

        <View style={[styles.columns, wide && styles.columnsWide]}>
          <View style={[styles.mainColumn, wide && styles.mainColumnWide]}>
            <View style={styles.panel}>
              <SectionHeading
                detail="Short, professional, and automatically removed after six hours."
                eyebrow="Live signal"
                title="Post an owner update"
              />

              <ScrollView
                contentContainerStyle={styles.typeRow}
                horizontal
                showsHorizontalScrollIndicator={false}>
                {updateTypes.map((type) => {
                  const active = updateType === type.id;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      aria-checked={active}
                      accessibilityState={{ checked: active }}
                      key={type.id}
                      onPress={() => setUpdateType(type.id)}
                      style={[styles.typeChip, active && styles.typeChipActive]}>
                      <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={type.icon} size={12} />
                      <Text style={[styles.typeText, active && styles.typeTextActive]}>{type.label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <View style={styles.composer}>
                <TextInput
                  accessibilityLabel="Owner update"
                   editable={canOperate}
                   maxLength={120}
                   multiline
                   onChangeText={setMessage}
                  placeholder="Example: Brisket is sold out. Tacos and veggie bowls are still serving."
                  placeholderTextColor={palette.mutedLight}
                  style={styles.composerInput}
                  textAlignVertical="top"
                  value={message}
                />
                <View style={styles.composerFooter}>
                  <View style={styles.moderationNote}>
                    <FontAwesome6 color={palette.success} name="wand-magic-sparkles" size={11} />
                    <Text style={styles.moderationText}>Professional language filter on</Text>
                  </View>
                  <Text style={styles.counter}>{message.length}/120</Text>
                </View>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: publishing || !message.trim() || !canOperate }}
                disabled={publishing || !message.trim() || !canOperate}
                onPress={publish}
                style={[
                  styles.publishButton,
                  (publishing || !message.trim() || !canOperate) && styles.buttonDisabled,
                ]}>
                {publishing ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Text style={styles.publishText}>Publish update</Text>
                    <FontAwesome6 color="#FFFFFF" name="arrow-up-right-from-square" size={12} />
                  </>
                )}
              </Pressable>

              {place.update ? (
                <View style={styles.currentUpdate}>
                  <Text style={styles.currentLabel}>Currently visible</Text>
                  <OwnerUpdate update={place.update} />
                </View>
              ) : null}
            </View>

            <View style={styles.panel}>
              <SectionHeading
                detail="Prices are stored as currency values and availability can change instantly."
                eyebrow="Menu"
                title="Today’s menu"
              />
              <View style={styles.menuList}>
                {place.menu.flatMap((section) =>
                  section.items.map((item) => {
                    const soldOut = soldOutIds.includes(item.id);
                    return (
                      <View key={item.id} style={styles.menuRow}>
                        <View style={styles.menuCopy}>
                          <Text style={[styles.menuName, soldOut && styles.soldOutName]}>{item.name}</Text>
                          <Text numberOfLines={1} style={styles.menuDescription}>
                            {item.description}
                          </Text>
                        </View>
                        <Text style={styles.menuPrice}>{currency.format(item.price)}</Text>
                        <Pressable
                          accessibilityRole="switch"
                          aria-checked={soldOut}
                          accessibilityState={{
                            busy: menuPendingIds.includes(item.id),
                            checked: soldOut,
                            disabled: !canOperate,
                          }}
                          disabled={menuPendingIds.includes(item.id) || !canOperate}
                          onPress={() => void toggleSoldOut(item.id)}
                          style={[styles.availabilityButton, soldOut && styles.availabilityButtonActive]}>
                          {menuPendingIds.includes(item.id) ? (
                            <ActivityIndicator color={soldOut ? '#FFFFFF' : palette.ink} size="small" />
                          ) : (
                            <Text style={[styles.availabilityText, soldOut && styles.availabilityTextActive]}>
                              {soldOut ? 'Sold out' : 'Available'}
                            </Text>
                          )}
                        </Pressable>
                      </View>
                    );
                  })
                )}
              </View>
              {!place.menu.length ? (
                <Text style={styles.emptyMenu}>No published menu yet. Add items during business setup.</Text>
              ) : null}
            </View>

            <View style={styles.panel}>
              <SectionHeading
                detail="Approved customer reviews only. Owner and manager responses are checked before they become public."
                eyebrow="Reputation"
                title="Respond to reviews"
              />

              {studioWriteSession &&
              responseQueue.session === studioWriteSession &&
              responseQueue.loading ? (
                <View
                  accessibilityLabel="Loading existing business responses"
                  style={styles.responseLoading}>
                  <ActivityIndicator color={palette.accentDeep} size="small" />
                  <Text style={styles.responseQuiet}>Checking response status…</Text>
                </View>
              ) : null}

              {studioWriteSession &&
              responseQueue.session === studioWriteSession &&
              responseQueue.businessId === place.id &&
              responseQueue.error ? (
                <View accessibilityRole="alert" style={styles.responseError}>
                  <FontAwesome6
                    color={palette.accentDeep}
                    name="triangle-exclamation"
                    size={12}
                  />
                  <View style={styles.responseErrorCopy}>
                    <Text style={styles.responseErrorText}>{responseQueue.error}</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void refreshResponseQueue()}
                      style={styles.responseRetry}>
                      <Text style={styles.responseRetryText}>Retry</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {place.reviews.length ? (
                <View style={styles.reviewList}>
                  {place.reviews.map((review) => {
                    const draftKey = `${studioWriteScope}:${review.id}`;
                    const responseRecord = queuedResponses.get(review.id);
                    const responseBody = responseRecord?.body ?? review.ownerResponse;
                    const responseState =
                      responseRecord?.moderationState ??
                      (review.ownerResponse ? 'approved' : undefined);
                    const draft = responseDrafts[draftKey] ?? responseBody ?? '';
                    const saving = responseSavingId === review.id;
                    const locked =
                      responseState === 'rejected' || responseState === 'removed';
                    return (
                      <View key={review.id} style={styles.reviewCard}>
                        <View style={styles.reviewHeader}>
                          <View style={styles.reviewerIdentity}>
                            <View style={styles.reviewerAvatar}>
                              <Text style={styles.reviewerInitial}>
                                {(review.displayName.trim()[0] ?? 'S').toLocaleUpperCase('en-US')}
                              </Text>
                            </View>
                            <View style={styles.reviewerCopy}>
                              <Text style={styles.reviewerName}>{review.displayName}</Text>
                              <Text style={styles.reviewMeta}>
                                @{review.username} · {review.createdAt}
                              </Text>
                            </View>
                          </View>
                          <View
                            accessibilityLabel={`${review.rating} out of 5 stars`}
                            style={styles.reviewStars}>
                            {Array.from({ length: 5 }, (_, index) => (
                              <FontAwesome6
                                color={index < review.rating ? palette.sun : palette.line}
                                key={`${review.id}-star-${index}`}
                                name="star"
                                size={11}
                                solid
                              />
                            ))}
                          </View>
                        </View>

                        <Text style={styles.reviewComment}>{review.comment}</Text>

                        {responseBody ? (
                          <View
                            accessibilityLabel={
                              responseState === 'approved'
                                ? 'Current public business response'
                                : `Business response status: ${responseState}`
                            }
                            style={[
                              styles.responseStatus,
                              responseState === 'approved' && styles.responseStatusApproved,
                            ]}>
                            <View style={styles.responseStatusHeader}>
                              <FontAwesome6
                                color={
                                  responseState === 'approved'
                                    ? palette.success
                                    : responseState === 'pending'
                                      ? palette.warning
                                      : palette.accentDeep
                                }
                                name={
                                  responseState === 'approved'
                                    ? 'circle-check'
                                    : responseState === 'pending'
                                      ? 'clock'
                                      : 'circle-exclamation'
                                }
                                size={11}
                                solid
                              />
                              <Text
                                style={[
                                  styles.responseStatusLabel,
                                  responseState === 'approved' &&
                                    styles.responseStatusLabelApproved,
                                ]}>
                                {responseState === 'approved'
                                  ? 'Public response'
                                  : responseState === 'pending'
                                    ? 'Pending safety review'
                                    : 'Response is not editable'}
                              </Text>
                            </View>
                            <Text style={styles.responseStatusBody}>{responseBody}</Text>
                          </View>
                        ) : null}

                        <View style={styles.responseComposer}>
                          <TextInput
                            accessibilityLabel={`Business response to ${review.displayName}`}
                            editable={!saving && !locked}
                            maxLength={BUSINESS_RESPONSE_MAX_LENGTH}
                            multiline
                            onChangeText={(value) =>
                              setResponseDrafts((current) => ({
                                ...current,
                                [draftKey]: value,
                              }))
                            }
                            placeholder="Thank them, answer clearly, and keep the response focused on their visit."
                            placeholderTextColor={palette.mutedLight}
                            style={styles.responseInput}
                            textAlignVertical="top"
                            value={draft}
                          />
                          <View style={styles.responseComposerFooter}>
                            <View style={styles.moderationNote}>
                              <FontAwesome6
                                color={palette.success}
                                name="shield-halved"
                                size={10}
                              />
                              <Text style={styles.moderationText}>
                                Professional language required
                              </Text>
                            </View>
                            <Text style={styles.counter}>
                              {draft.length}/{BUSINESS_RESPONSE_MAX_LENGTH}
                            </Text>
                          </View>
                        </View>

                        <View style={styles.responseActions}>
                          <Text style={styles.responseReviewNote}>
                            Pending responses are not shown to customers until approved.
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{
                              busy: saving,
                              disabled: saving || locked || !draft.trim() || !canOperate,
                            }}
                            disabled={saving || locked || !draft.trim() || !canOperate}
                            onPress={() => void submitReviewResponse(review)}
                            style={[
                              styles.responseSubmit,
                              (saving || locked || !draft.trim() || !canOperate) &&
                                styles.buttonDisabled,
                            ]}>
                            {saving ? (
                              <ActivityIndicator color="#FFFFFF" size="small" />
                            ) : (
                              <FontAwesome6 color="#FFFFFF" name="reply" size={11} />
                            )}
                            <Text style={styles.responseSubmitText}>
                              {responseBody ? 'Submit revision' : 'Submit response'}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.emptyReviews}>
                  <View style={styles.emptyReviewsIcon}>
                    <FontAwesome6 color={palette.muted} name="comment-dots" size={16} />
                  </View>
                  <View style={styles.emptyReviewsCopy}>
                    <Text style={styles.emptyReviewsTitle}>No approved reviews yet</Text>
                    <Text style={styles.emptyMenu}>
                      Customer reviews will appear here after they pass safety checks.
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </View>

          <View style={[styles.sideColumn, wide && styles.sideColumnWide]}>
            {publishedMobile ? (
              <View style={styles.sidePanel}>
                <View style={styles.sideHeader}>
                  <View style={styles.scheduleHeading}>
                    <Text style={styles.sideTitle}>Upcoming stops</Text>
                    <Text style={styles.scheduleTimeZone}>
                      {mobileSchedule?.business.timezone ?? 'Business time zone'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled:
                        scheduleLoading ||
                        scheduleSaving ||
                        !mobileSchedule?.locations.length,
                    }}
                    disabled={
                      scheduleLoading ||
                      scheduleSaving ||
                      !mobileSchedule?.locations.length
                    }
                    onPress={beginNewStop}
                    style={[
                      styles.scheduleAddButton,
                      (scheduleLoading ||
                        scheduleSaving ||
                        !mobileSchedule?.locations.length) &&
                        styles.buttonDisabled,
                    ]}>
                    <FontAwesome6 color={palette.ink} name="plus" size={9} />
                    <Text style={styles.scheduleAddText}>Add stop</Text>
                  </Pressable>
                </View>

                {scheduleLoading ? (
                  <View style={styles.scheduleLoading}>
                    <ActivityIndicator color={palette.accentDeep} size="small" />
                    <Text style={styles.detailText}>Loading published stop pins…</Text>
                  </View>
                ) : null}

                {scheduleError ? (
                  <View accessibilityRole="alert" style={styles.scheduleError}>
                    <FontAwesome6
                      color={palette.accentDeep}
                      name="triangle-exclamation"
                      size={11}
                    />
                    <Text style={styles.scheduleErrorText}>{scheduleError}</Text>
                  </View>
                ) : null}

                {!scheduleLoading && mobileSchedule && !mobileSchedule.locations.length ? (
                  <Text style={styles.emptyMenu}>
                    No published stop pins are available. A new location must complete review
                    before it can be scheduled.
                  </Text>
                ) : null}

                {mobileSchedule?.stops.length ? (
                  <View style={styles.upcomingStopList}>
                    {mobileSchedule.stops.map((stop) => {
                      const stopLocation = mobileSchedule.locations.find(
                        (entry) => entry.id === stop.locationId
                      );
                      return (
                        <Pressable
                          accessibilityHint="Opens this stop for editing"
                          accessibilityRole="button"
                          key={stop.id}
                          onPress={() => {
                            setStopEditor({ ...stop });
                            setScheduleError(null);
                          }}
                          style={styles.upcomingStopRow}>
                          <View style={styles.upcomingStopIcon}>
                            <FontAwesome6
                              color={palette.accentDeep}
                              name="location-dot"
                              size={11}
                            />
                          </View>
                          <View style={styles.upcomingStopCopy}>
                            <Text style={styles.upcomingStopTitle}>
                              {stopLocation?.label ?? 'Location awaiting approval'}
                            </Text>
                            <Text style={styles.upcomingStopDetail}>
                              {stop.state === 'live'
                                ? 'Live now · '
                                : stop.state === 'draft'
                                  ? 'Draft · '
                                  : ''}
                              {stop.startsOn} · {stop.startsAt}–{stop.endsAt}
                            </Text>
                          </View>
                          <Text style={styles.editText}>Edit</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : !scheduleLoading && mobileSchedule?.locations.length ? (
                  <Text style={styles.emptyMenu}>
                    No upcoming stops. Add the next place and time customers can find you.
                  </Text>
                ) : null}

                {stopEditor && mobileSchedule ? (
                  <View style={styles.stopEditor}>
                    <Text style={styles.controlLabel}>Published service pin</Text>
                    <View
                      accessibilityLabel="Choose a published service pin"
                      accessibilityRole="radiogroup"
                      style={styles.scheduleLocationChoices}>
                      {mobileSchedule.locations.map((entry) => {
                        const selected = stopEditor.locationId === entry.id;
                        return (
                          <Pressable
                            accessibilityRole="radio"
                            aria-checked={selected}
                            accessibilityState={{
                              checked: selected,
                              disabled:
                                scheduleSaving || stopEditor.state === 'live',
                            }}
                            disabled={scheduleSaving || stopEditor.state === 'live'}
                            key={entry.id}
                            onPress={() =>
                              setStopEditor((current) =>
                                current
                                  ? { ...current, locationId: entry.id! }
                                  : current
                              )
                            }
                            style={[
                              styles.scheduleLocationChoice,
                              selected && styles.scheduleLocationChoiceActive,
                            ]}>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.scheduleLocationText,
                                selected && styles.scheduleLocationTextActive,
                              ]}>
                              {entry.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {!mobileSchedule.locations.some(
                      (entry) => entry.id === stopEditor.locationId
                    ) ? (
                      <View accessibilityRole="alert" style={styles.scheduleError}>
                        <FontAwesome6
                          color={palette.accentDeep}
                          name="clock-rotate-left"
                          size={11}
                        />
                        <Text style={styles.scheduleErrorText}>
                          This stop’s pin is still under review. Choose an approved pin or wait for
                          location approval.
                        </Text>
                      </View>
                    ) : null}

                    <Text style={styles.controlLabel}>Starts</Text>
                    <View style={styles.scheduleFieldRow}>
                      <TextInput
                        accessibilityLabel="Stop start date"
                        autoCapitalize="none"
                        editable={!scheduleSaving && stopEditor.state !== 'live'}
                        maxLength={10}
                        onChangeText={(value) =>
                          setStopEditor((current) =>
                            current ? { ...current, startsOn: value } : current
                          )
                        }
                        placeholder="2026-08-15"
                        placeholderTextColor={palette.mutedLight}
                        style={styles.scheduleInput}
                        value={stopEditor.startsOn}
                      />
                      <TextInput
                        accessibilityLabel="Stop start time"
                        autoCapitalize="none"
                        editable={!scheduleSaving && stopEditor.state !== 'live'}
                        maxLength={5}
                        onChangeText={(value) =>
                          setStopEditor((current) =>
                            current ? { ...current, startsAt: value } : current
                          )
                        }
                        placeholder="11:00"
                        placeholderTextColor={palette.mutedLight}
                        style={styles.scheduleTimeInput}
                        value={stopEditor.startsAt}
                      />
                    </View>

                    <Text style={styles.controlLabel}>Ends</Text>
                    <View style={styles.scheduleFieldRow}>
                      <TextInput
                        accessibilityLabel="Stop end date"
                        autoCapitalize="none"
                        editable={!scheduleSaving}
                        maxLength={10}
                        onChangeText={(value) =>
                          setStopEditor((current) =>
                            current ? { ...current, endsOn: value } : current
                          )
                        }
                        placeholder="2026-08-15"
                        placeholderTextColor={palette.mutedLight}
                        style={styles.scheduleInput}
                        value={stopEditor.endsOn}
                      />
                      <TextInput
                        accessibilityLabel="Stop end time"
                        autoCapitalize="none"
                        editable={!scheduleSaving}
                        maxLength={5}
                        onChangeText={(value) =>
                          setStopEditor((current) =>
                            current ? { ...current, endsAt: value } : current
                          )
                        }
                        placeholder="14:00"
                        placeholderTextColor={palette.mutedLight}
                        style={styles.scheduleTimeInput}
                        value={stopEditor.endsAt}
                      />
                    </View>

                    <Text style={styles.scheduleHelp}>
                      {stopEditor.state === 'live'
                        ? 'This stop is live. You can extend its end time or cancel it.'
                        : 'Use YYYY-MM-DD and 24-hour time. Stops may last up to seven days.'}
                    </Text>
                    <View style={styles.scheduleActions}>
                      {stopEditor.id ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ disabled: scheduleSaving }}
                          disabled={scheduleSaving}
                          onPress={() => void cancelScheduledStop()}
                          style={styles.scheduleCancelButton}>
                          <Text style={styles.scheduleDeleteText}>
                            {stopEditor.state === 'draft' ? 'Discard draft' : 'Cancel stop'}
                          </Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: scheduleSaving }}
                        disabled={scheduleSaving}
                        onPress={() => setStopEditor(null)}
                        style={styles.scheduleCancelButton}>
                        <Text style={styles.scheduleCancelText}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{
                          busy: scheduleSaving,
                          disabled:
                            scheduleSaving ||
                            !mobileSchedule.locations.some(
                              (entry) => entry.id === stopEditor.locationId
                            ),
                        }}
                        disabled={
                          scheduleSaving ||
                          !mobileSchedule.locations.some(
                            (entry) => entry.id === stopEditor.locationId
                          )
                        }
                        onPress={() => void saveScheduledStop()}
                        style={[
                          styles.scheduleSaveButton,
                          (scheduleSaving ||
                            !mobileSchedule.locations.some(
                              (entry) => entry.id === stopEditor.locationId
                            )) &&
                            styles.buttonDisabled,
                        ]}>
                        {scheduleSaving ? (
                          <ActivityIndicator color="#FFFFFF" size="small" />
                        ) : (
                          <FontAwesome6 color="#FFFFFF" name="calendar-check" size={10} />
                        )}
                        <Text style={styles.scheduleSaveText}>
                          {stopEditor.id ? 'Update stop' : 'Schedule stop'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}

            <View style={styles.sidePanel}>
              <View style={styles.sideHeader}>
                <Text style={styles.sideTitle}>Today’s stop</Text>
              </View>
              <View style={styles.locationPreview}>
                <FontAwesome6 color={palette.accent} name="location-dot" size={18} solid />
                <View style={styles.locationCopy}>
                  <Text style={styles.locationName}>{place.address}</Text>
                  <Text style={styles.locationDetail}>
                    {[place.city, place.postalCode].filter(Boolean).join(' ')}
                  </Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <FontAwesome6 color={palette.muted} name="clock" size={13} />
                <Text style={styles.detailText}>{place.todayHours}</Text>
              </View>
              <View style={styles.detailRow}>
                <FontAwesome6 color={palette.muted} name="location-crosshairs" size={13} />
                <Text style={styles.detailText}>Last confirmed {place.lastConfirmedAt.toLowerCase()}</Text>
              </View>
            </View>

            <View style={styles.sidePanel}>
              <View style={styles.sideHeader}>
                <Text style={styles.sideTitle}>Payments</Text>
              </View>
              <View style={styles.paymentWrap}>
                {place.payments.map((payment) => (
                  <View key={payment} style={styles.paymentChip}>
                    <FontAwesome6 color={palette.ink} name="check" size={10} />
                    <Text style={styles.paymentText}>{payment}</Text>
                  </View>
                ))}
                {!place.payments.length ? (
                  <Text style={styles.emptyMenu}>Payment methods have not been added yet.</Text>
                ) : null}
              </View>
            </View>

            <Link
              href={{
                pathname: '/business-profile',
                params: { businessId: place.id },
              } as unknown as Href}
              asChild>
              <Pressable
                accessibilityHint="Edit public identity and contact visibility"
                accessibilityRole="button"
                style={styles.teamLink}>
                <View style={styles.teamLinkIcon}>
                  <FontAwesome6 color={palette.accentDeep} name="address-card" size={15} />
                </View>
                <View style={styles.teamLinkCopy}>
                  <Text style={styles.teamLinkTitle}>Business profile</Text>
                  <Text style={styles.teamLinkDetail}>
                    Edit identity, logo, cuisine, and contact visibility.
                  </Text>
                </View>
                <FontAwesome6 color={palette.ink} name="arrow-right" size={13} />
              </Pressable>
            </Link>

            <Link
              href={{
                pathname: '/business-team',
                params: { businessId: place.id },
              } as unknown as Href}
              asChild>
              <Pressable
                accessibilityHint="Manage members, roles, and invitations"
                accessibilityRole="button"
                style={styles.teamLink}>
                <View style={styles.teamLinkIcon}>
                  <FontAwesome6 color={palette.accentDeep} name="users-gear" size={15} />
                </View>
                <View style={styles.teamLinkCopy}>
                  <Text style={styles.teamLinkTitle}>Team access</Text>
                  <Text style={styles.teamLinkDetail}>
                    Review roles and invite trusted staff.
                  </Text>
                </View>
                <FontAwesome6 color={palette.ink} name="arrow-right" size={13} />
              </Pressable>
            </Link>

            {(place.category === 'home_kitchen' || place.category === 'pop_up') ? (
              <Link
                href={{
                  pathname: '/business-marketplace',
                  params: { businessId: place.id },
                } as unknown as Href}
                asChild>
                <Pressable
                  accessibilityHint="Manage private customer chat and reviewed pickup sites"
                  accessibilityRole="button"
                  style={styles.teamLink}>
                  <View style={styles.teamLinkIcon}>
                    <FontAwesome6 color={palette.accentDeep} name="comments" size={15} />
                  </View>
                  <View style={styles.teamLinkCopy}>
                    <Text style={styles.teamLinkTitle}>Chat &amp; safe pickup</Text>
                    <Text style={styles.teamLinkDetail}>
                      Manage customer chat and non-residential handoff points.
                    </Text>
                  </View>
                  <FontAwesome6 color={palette.ink} name="arrow-right" size={13} />
                </Pressable>
              </Link>
            ) : null}

            <Link href="/business-onboarding" asChild>
              <Pressable style={styles.onboardingLink}>
                <View>
                  <Text style={styles.onboardingTitle}>Add or claim a business</Text>
                  <Text style={styles.onboardingDetail}>Start a separate verified listing.</Text>
                </View>
                <FontAwesome6 color={palette.ink} name="arrow-right" size={13} />
              </Pressable>
            </Link>
          </View>
        </View>
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
    paddingBottom: 132,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  secureBadge: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secureText: {
    color: palette.success,
    fontSize: 11,
    fontWeight: '900',
  },
  accessGate: {
    alignItems: 'flex-start',
    alignSelf: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    marginTop: spacing.xxxl,
    maxWidth: 620,
    padding: spacing.xl,
    width: '100%',
  },
  accessIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.lg,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  accessTitle: {
    color: palette.ink,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1.4,
    lineHeight: 38,
  },
  accessBody: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  accessPrimary: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  accessPrimaryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  businessSwitcher: {
    gap: spacing.sm,
    paddingTop: spacing.lg,
  },
  businessSwitch: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    maxWidth: 220,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  businessSwitchActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  businessSwitchText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  businessSwitchTextActive: {
    color: '#FFFFFF',
  },
  businessHeader: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  businessIdentity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  logoFallback: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.md,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  businessCopy: {
    gap: 4,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  businessName: {
    color: palette.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  businessMeta: {
    color: palette.muted,
    fontSize: 11,
  },
  hero: {
    gap: spacing.sm,
    marginTop: spacing.xl,
    maxWidth: 720,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 40,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 620,
  },
  reviewState: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.lg,
  },
  reviewStateCopy: {
    flex: 1,
    gap: 4,
  },
  reviewStateTitle: {
    color: palette.warning,
    fontSize: 13,
    fontWeight: '900',
  },
  reviewStateDetail: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  setupButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  setupButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  quickActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  quickAction: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 60,
    minWidth: 150,
    padding: spacing.md,
  },
  quickActionActive: {
    backgroundColor: palette.dark,
    borderColor: palette.dark,
  },
  quickIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 35,
    justifyContent: 'center',
    width: 35,
  },
  quickIconActive: {
    backgroundColor: palette.accent,
  },
  quickLabel: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  quickLabelActive: {
    color: '#FFFFFF',
  },
  stats: {
    borderBottomColor: palette.line,
    borderTopColor: palette.line,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.xxl,
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
  stat: {
    flex: 1,
    gap: 5,
    minWidth: 145,
    paddingVertical: spacing.lg,
  },
  statValue: {
    color: palette.ink,
    fontSize: 27,
    fontWeight: '900',
    letterSpacing: -1,
  },
  statLabel: {
    color: palette.muted,
    fontSize: 11,
  },
  statTrend: {
    color: palette.success,
    fontSize: 11,
    fontWeight: '800',
  },
  statQuiet: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  columns: {
    gap: spacing.lg,
    marginTop: spacing.xxl,
  },
  columnsWide: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  mainColumn: {
    gap: spacing.lg,
  },
  mainColumnWide: {
    flex: 1.2,
  },
  sideColumn: {
    gap: spacing.lg,
  },
  sideColumnWide: {
    flex: 0.8,
  },
  panel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  typeRow: {
    gap: spacing.sm,
  },
  typeChip: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  typeChipActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  typeText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
  },
  typeTextActive: {
    color: '#FFFFFF',
  },
  composer: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  composerInput: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 21,
    minHeight: 100,
    padding: spacing.md,
  },
  composerFooter: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  moderationNote: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  moderationText: {
    color: palette.success,
    fontSize: 10,
    fontWeight: '700',
  },
  counter: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 10,
  },
  publishButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 154,
    paddingHorizontal: 17,
    paddingVertical: 12,
  },
  publishText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  currentUpdate: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingTop: spacing.lg,
  },
  currentLabel: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  menuList: {
    gap: 0,
  },
  menuRow: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  menuCopy: {
    flex: 1,
    gap: 4,
  },
  menuName: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  soldOutName: {
    color: palette.muted,
    textDecorationLine: 'line-through',
  },
  menuDescription: {
    color: palette.muted,
    fontSize: 10,
  },
  menuPrice: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  availabilityButton: {
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    minHeight: 44,
    minWidth: 82,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  availabilityButtonActive: {
    backgroundColor: '#ECEDEB',
  },
  availabilityText: {
    color: palette.success,
    fontSize: 9,
    fontWeight: '900',
  },
  availabilityTextActive: {
    color: palette.muted,
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  emptyMenu: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  responseLoading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
  },
  responseQuiet: {
    color: palette.muted,
    fontSize: 11,
  },
  responseError: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  responseErrorCopy: {
    alignItems: 'flex-start',
    flex: 1,
    gap: spacing.sm,
  },
  responseErrorText: {
    color: palette.accentDeep,
    fontSize: 11,
    lineHeight: 16,
  },
  responseRetry: {
    alignItems: 'center',
    borderColor: palette.accentDeep,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  responseRetryText: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '900',
  },
  reviewList: {
    gap: spacing.md,
  },
  reviewCard: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  reviewHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  reviewerIdentity: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minWidth: 180,
  },
  reviewerAvatar: {
    alignItems: 'center',
    backgroundColor: palette.mint,
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  reviewerInitial: {
    color: palette.dark,
    fontSize: 13,
    fontWeight: '900',
  },
  reviewerCopy: {
    flex: 1,
    gap: 2,
  },
  reviewerName: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  reviewMeta: {
    color: palette.muted,
    fontSize: 9,
  },
  reviewStars: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
    minHeight: 38,
  },
  reviewComment: {
    color: palette.ink,
    fontSize: 13,
    lineHeight: 20,
  },
  responseStatus: {
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  responseStatusApproved: {
    backgroundColor: palette.successSoft,
  },
  responseStatusHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  responseStatusLabel: {
    color: palette.warning,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  responseStatusLabelApproved: {
    color: palette.success,
  },
  responseStatusBody: {
    color: palette.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  responseComposer: {
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  responseInput: {
    color: palette.ink,
    fontSize: 12,
    lineHeight: 18,
    minHeight: 92,
    padding: spacing.md,
  },
  responseComposerFooter: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  responseActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  responseReviewNote: {
    color: palette.muted,
    flex: 1,
    fontSize: 9,
    lineHeight: 14,
    minWidth: 180,
  },
  responseSubmit: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: spacing.md,
  },
  responseSubmitText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
  },
  emptyReviews: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  emptyReviewsIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  emptyReviewsCopy: {
    flex: 1,
    gap: 3,
  },
  emptyReviewsTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  buttonDisabled: {
    opacity: 0.58,
  },
  scheduleHeading: {
    flex: 1,
    gap: 3,
  },
  scheduleTimeZone: {
    color: palette.muted,
    fontSize: 9,
  },
  scheduleAddButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 11,
  },
  scheduleAddText: {
    color: palette.ink,
    fontSize: 9,
    fontWeight: '900',
  },
  scheduleLoading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
  },
  scheduleError: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  scheduleErrorText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
  upcomingStopList: {
    gap: spacing.sm,
  },
  upcomingStopRow: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 58,
    padding: spacing.sm,
  },
  upcomingStopIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  upcomingStopCopy: {
    flex: 1,
    gap: 3,
  },
  upcomingStopTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  upcomingStopDetail: {
    color: palette.muted,
    fontSize: 9,
  },
  stopEditor: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  controlLabel: {
    color: palette.muted,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  scheduleLocationChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  scheduleLocationChoice: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    maxWidth: '100%',
    minHeight: 42,
    paddingHorizontal: spacing.md,
  },
  scheduleLocationChoiceActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  scheduleLocationText: {
    color: palette.ink,
    fontSize: 9,
    fontWeight: '800',
  },
  scheduleLocationTextActive: {
    color: '#FFFFFF',
  },
  scheduleFieldRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  scheduleInput: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    flex: 1,
    fontSize: 11,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  scheduleTimeInput: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 11,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    width: 78,
  },
  scheduleHelp: {
    color: palette.muted,
    fontSize: 9,
    lineHeight: 14,
  },
  scheduleActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'flex-end',
  },
  scheduleCancelButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  scheduleCancelText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: '800',
  },
  scheduleDeleteText: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '900',
  },
  scheduleSaveButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  scheduleSaveText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
  },
  sidePanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  sideHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sideTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  editText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  locationPreview: {
    alignItems: 'flex-start',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  locationCopy: {
    flex: 1,
    gap: 3,
  },
  locationName: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  locationDetail: {
    color: palette.muted,
    fontSize: 10,
  },
  detailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  detailText: {
    color: palette.muted,
    fontSize: 11,
  },
  paymentWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  paymentChip: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  paymentText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
  },
  onboardingLink: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  teamLink: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderTopColor: palette.line,
    borderBottomWidth: 1,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 72,
    paddingVertical: spacing.md,
  },
  teamLinkIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  teamLinkCopy: {
    flex: 1,
    gap: 3,
  },
  teamLinkTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  teamLinkDetail: {
    color: palette.muted,
    fontSize: 10,
  },
  onboardingTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  onboardingDetail: {
    color: palette.muted,
    fontSize: 10,
    marginTop: 4,
  },
});
