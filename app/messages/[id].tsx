import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { chatSafetyIssue, chatSafetyMessage } from '@/lib/chat-safety';
import {
  getMarketplaceMessages,
  getAuthorizedMarketplacePickupDetail,
  getMarketplaceConversationRole,
  getMarketplaceTyping,
  listMarketplacePickupOptions,
  listMarketplacePickupRequests,
  listMarketplaceConversations,
  markMarketplaceConversationRead,
  reportMarketplaceMessage,
  requestMarketplacePickup,
  resolveMarketplacePickup,
  sendMarketplaceMessage,
  setMarketplaceTyping,
  authorizeMarketplacePickup,
} from '@/lib/marketplace-chat';
import { blockUser } from '@/lib/marketplace-api';
import { mediaProcessingStates, stageMediaUpload } from '@/lib/media-upload';
import { confirmAction, showMessage } from '@/lib/platform-dialog';
import type { MarketplaceChatMessage, MarketplaceConversation, MarketplacePickupDetail, MarketplacePickupOption, MarketplacePickupRequest, MarketplaceTypingMember } from '@/types/chat';

const sentTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pickupTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function pickupWindowFromNow(minutesFromNow: number) {
  const startsAt = new Date(Date.now() + minutesFromNow * 60_000);
  return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000) };
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const auth = useAuth();
  const focused = useIsFocused();
  const scrollRef = useRef<ScrollView | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickupDetailRequestRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<MarketplaceChatMessage[]>([]);
  const [conversation, setConversation] = useState<MarketplaceConversation | null>(null);
  const [typing, setTyping] = useState<MarketplaceTypingMember[]>([]);
  const [pickupRole, setPickupRole] = useState<'customer' | 'merchant' | null>(null);
  const [pickupRequests, setPickupRequests] = useState<MarketplacePickupRequest[]>([]);
  const [pickupOptions, setPickupOptions] = useState<MarketplacePickupOption[]>([]);
  const [pickupDetail, setPickupDetail] = useState<MarketplacePickupDetail | null>(null);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [photos, setPhotos] = useState<{ assetId: string; uri: string; state: 'pending' | 'approved' | 'rejected' }[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftSafetyIssue = chatSafetyIssue(draft);
  const threadClosed = Boolean(conversation && conversation.state !== 'open');
  const activePickup = pickupRequests.find((request) => request.state === 'pending' || request.state === 'authorized');

  const refresh = useCallback(async (quiet = false) => {
    if (!id) return;
    if (!quiet) setLoading(true);
    const [messageResult, typingMembers, requestResult, role] = await Promise.all([
      getMarketplaceMessages(id),
      getMarketplaceTyping(id),
      listMarketplacePickupRequests(id),
      getMarketplaceConversationRole(id),
    ]);
    if (!quiet) setLoading(false);
    if (!messageResult.ok) {
      setError(messageResult.reason);
      return;
    }
    const nextMessages = messageResult.data ?? [];
    setError(null);
    setMessages(nextMessages);
    setTyping(typingMembers);
    setPickupRole(role);
    if (requestResult.ok) {
      const nextRequests = requestResult.data ?? [];
      setPickupRequests(nextRequests);
      const authorized = nextRequests.find((request) => request.state === 'authorized');
      if (authorized && pickupDetailRequestRef.current !== authorized.id) {
        const detailResult = await getAuthorizedMarketplacePickupDetail(id, authorized.id);
        if (detailResult.ok) {
          pickupDetailRequestRef.current = authorized.id;
          setPickupDetail(detailResult.data ?? null);
        } else {
          pickupDetailRequestRef.current = authorized.id;
          setPickupDetail(null);
        }
      } else {
        if (!authorized) {
          pickupDetailRequestRef.current = null;
          setPickupDetail(null);
        }
      }
    }
    if (role === 'merchant') {
      const optionResult = await listMarketplacePickupOptions(id);
      if (optionResult.ok) setPickupOptions(optionResult.data ?? []);
    }
    const latest = nextMessages.at(-1)?.sequence ?? 0;
    if (latest) void markMarketplaceConversationRead(id, latest);
  }, [id]);

  useEffect(() => {
    if (!focused || auth.status !== 'authenticated') return;
    const initialTimer = setTimeout(() => {
      void listMarketplaceConversations().then((result) => {
        if (result.ok) setConversation((result.data ?? []).find((entry) => entry.id === id) ?? null);
      });
      void refresh();
    }, 0);
    const interval = setInterval(() => void refresh(true), 4_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [auth.status, focused, id, refresh]);

  useEffect(() => {
    const pendingIds = photos.filter((photo) => photo.state === 'pending').map((photo) => photo.assetId);
    if (!focused || !pendingIds.length) return;
    const check = async () => {
      if (!id) return;
      const states = await mediaProcessingStates(id, pendingIds);
      setPhotos((current) => {
        let changed = false;
        const next = current.map((photo) => {
          const state = states.get(photo.assetId) ?? photo.state;
          if (state === photo.state) return photo;
          changed = true;
          return { ...photo, state };
        });
        return changed ? next : current;
      });
    };
    void check();
    const interval = setInterval(() => void check(), 3_000);
    return () => clearInterval(interval);
  }, [focused, id, photos]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (id) void setMarketplaceTyping(id, false);
  }, [id]);

  useEffect(() => {
    if (!pickupDetail) return;
    const expiresAt = new Date(pickupDetail.expiresAt).getTime();
    const delay = expiresAt - Date.now();
    if (!Number.isFinite(expiresAt) || delay <= 0) {
      const timer = setTimeout(() => setPickupDetail(null), 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setPickupDetail(null), delay + 250);
    return () => clearTimeout(timer);
  }, [pickupDetail]);

  useEffect(() => {
    if (!loading && messages.length) {
      const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 30);
      return () => clearTimeout(timer);
    }
  }, [loading, messages.length]);

  const changeDraft = (value: string) => {
    setDraft(value.slice(0, 1_000));
    if (!id) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    void setMarketplaceTyping(id, Boolean(value.trim()));
    typingTimer.current = setTimeout(() => void setMarketplaceTyping(id, false), 2_500);
  };

  const send = async () => {
    const body = draft.replace(/\s+/g, ' ').trim();
    const approvedAssets = photos.filter((photo) => photo.state === 'approved').map((photo) => photo.assetId);
    if (!id || draftSafetyIssue || threadClosed || (!body && !approvedAssets.length) || photos.some((photo) => photo.state === 'pending') || sending) return;
    setSending(true);
    const result = await sendMarketplaceMessage(id, body, approvedAssets);
    setSending(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setDraft('');
    setPhotos([]);
    void setMarketplaceTyping(id, false);
    await refresh(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 30);
  };

  const pickPhoto = async () => {
    if (!id || !conversation || threadClosed || photos.length >= 4) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showMessage('Photo access needed', 'Allow photo access to attach an image to this conversation.');
      return;
    }
    const selection = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: false,
      mediaTypes: ['images'],
      quality: 0.9,
    });
    if (selection.canceled || !selection.assets[0]) return;
    const selected = selection.assets[0];
    const result = await stageMediaUpload(
      { uri: selected.uri, mimeType: selected.mimeType, fileSize: selected.fileSize },
      'chat_photo',
      conversation.businessId,
      id
    );
    if (!result.ok || !result.data) {
      showMessage('Photo unavailable', result.ok ? 'This photo could not be staged.' : result.reason);
      return;
    }
    setPhotos((current) => [...current, { assetId: result.data!.assetId, uri: selected.uri, state: 'pending' }]);
  };

  const requestPickupWindow = async (minutesFromNow: number) => {
    if (!id || pickupBusy || pickupRole !== 'customer') return;
    const { startsAt, endsAt } = pickupWindowFromNow(minutesFromNow);
    setPickupBusy(true);
    const result = await requestMarketplacePickup(id, startsAt, endsAt);
    setPickupBusy(false);
    if (!result.ok) {
      showMessage('Pickup request unavailable', result.reason);
      return;
    }
    await refresh(true);
  };

  const authorizePickup = async (request: MarketplacePickupRequest, option: MarketplacePickupOption) => {
    if (!id || pickupBusy || pickupRole !== 'merchant') return;
    if (auth.assuranceLevel !== 'aal2') {
      showMessage('Verification required', 'Verify an authenticator code before releasing exact pickup details.');
      router.push('/security');
      return;
    }
    setPickupBusy(true);
    const result = await authorizeMarketplacePickup(id, request.id, option.id, request.version);
    setPickupBusy(false);
    if (!result.ok) {
      showMessage('Pickup authorization unavailable', result.reason);
      return;
    }
    pickupDetailRequestRef.current = null;
    await refresh(true);
  };

  const resolvePickup = async (request: MarketplacePickupRequest) => {
    if (!id || pickupBusy) return;
    const resolution = pickupRole === 'customer'
      ? 'cancel'
      : request.state === 'authorized' ? 'revoke' : 'decline';
    setPickupBusy(true);
    const result = await resolveMarketplacePickup(id, request.id, resolution, request.version);
    setPickupBusy(false);
    if (!result.ok) {
      showMessage('Pickup update unavailable', result.reason);
      return;
    }
    pickupDetailRequestRef.current = null;
    await refresh(true);
  };

  const openPickupDirections = async () => {
    if (!pickupDetail) return;
    const destination = `${pickupDetail.latitude},${pickupDetail.longitude}`;
    const url = Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${encodeURIComponent(destination)}&dirflg=d`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
    await Linking.openURL(url);
  };

  const safetyAction = async (message: MarketplaceChatMessage) => {
    const shouldReport = await confirmAction({
      title: 'Report this message?',
      message: 'Spottr staff will review the message. You can block this member separately from Safety controls.',
      confirmLabel: 'Report',
      destructive: true,
    });
    if (!shouldReport) return;
    const result = await reportMarketplaceMessage(message.id);
    showMessage(result.ok ? 'Report received' : 'Report unavailable', result.ok ? 'Spottr staff will review this message.' : result.reason);
  };

  const blockCounterpart = async () => {
    const counterpart = conversation?.counterpart;
    if (!counterpart?.profileId) return;
    const confirmed = await confirmAction({
      title: `Block ${counterpart.name}?`,
      message: 'Blocking stops new chat activity and hides this member across Spottr.',
      confirmLabel: 'Block member',
      destructive: true,
    });
    if (!confirmed) return;
    const result = await blockUser(counterpart.profileId);
    if (result.ok) router.replace('/messages' as never);
    else showMessage('Could not block member', result.reason);
  };

  return (
    <FocusAwareScreen>
      <PageShell>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.page}>
          <View style={styles.header}>
            <Pressable accessibilityLabel="Back to messages" accessibilityRole="button" onPress={() => router.replace('/messages' as never)} style={styles.iconButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={14} />
            </Pressable>
            <View style={styles.headerCopy}>
              <Text style={styles.headerTitle}>{conversation?.counterpart.name ?? 'Private conversation'}</Text>
              <Text style={styles.headerMeta}>{conversation ? `${conversation.counterpart.username ? `@${conversation.counterpart.username} · ` : ''}${conversation.businessName}` : 'Encrypted in transit · participant-only access'}</Text>
            </View>
            <Pressable accessibilityLabel="Block conversation member" accessibilityRole="button" accessibilityState={{ disabled: !conversation?.counterpart.profileId }} disabled={!conversation?.counterpart.profileId} onPress={() => void blockCounterpart()} style={[styles.iconButton, !conversation?.counterpart.profileId && styles.iconButtonDisabled]}>
              <FontAwesome6 color={palette.accentDeep} name="user-slash" size={13} />
            </Pressable>
          </View>

          <View style={styles.privacyBanner}>
            <FontAwesome6 color={palette.success} name="shield-halved" size={13} />
            <Text style={styles.privacyText}>Do not post a home address in messages. Exact pickup details appear only in a verified, expiring pickup card.</Text>
          </View>

          {auth.status !== 'authenticated' ? (
            <View style={styles.center}>
              <Text style={styles.centerTitle}>Sign in required</Text>
              <Pressable onPress={() => router.replace('/auth')} style={styles.sendButton}><Text style={styles.sendText}>Sign in</Text></Pressable>
            </View>
          ) : loading ? (
            <View accessibilityLiveRegion="polite" style={styles.center}>
              <ActivityIndicator color={palette.accentDeep} />
              <Text style={styles.centerBody}>Loading private messages…</Text>
            </View>
          ) : error && !messages.length ? (
            <View accessibilityRole="alert" style={styles.center}>
              <FontAwesome6 color={palette.accentDeep} name="triangle-exclamation" size={20} />
              <Text style={styles.centerTitle}>Conversation unavailable</Text>
              <Text style={styles.centerBody}>{error}</Text>
            </View>
          ) : (
            <>
              <ScrollView
                contentContainerStyle={styles.messages}
                keyboardShouldPersistTaps="handled"
                ref={scrollRef}>
                {messages.map((message) => {
                  const mine = message.sender.username === auth.account?.username;
                  return (
                    <View key={message.id} style={[styles.messageRow, mine && styles.messageRowMine]}>
                      {!mine ? (
                        message.sender.avatarUrl ? <Image source={{ uri: message.sender.avatarUrl }} style={styles.avatar} /> :
                          <View style={styles.avatarFallback}><Text style={styles.avatarText}>{message.sender.name.slice(0, 1).toUpperCase()}</Text></View>
                      ) : null}
                      <View style={[styles.bubbleWrap, mine && styles.bubbleWrapMine]}>
                        {!mine ? <Text style={styles.senderName}>{message.sender.name}{message.sender.username ? ` · @${message.sender.username}` : ''}</Text> : null}
                        <View style={[styles.bubble, mine && styles.bubbleMine]}>
                          {message.body ? <Text style={[styles.body, mine && styles.bodyMine]}>{message.body}</Text> : null}
                          {message.attachments.map((attachment) => (
                            <Image accessibilityLabel="Chat photo" key={attachment.assetId} source={{ uri: attachment.url }} style={styles.attachment} />
                          ))}
                        </View>
                        <View style={[styles.metaLine, mine && styles.metaLineMine]}>
                          <Text style={styles.messageTime}>{sentTime.format(new Date(message.sentAt))}</Text>
                          {mine ? <Text style={styles.readState}>{message.readAt ? 'Read' : 'Sent'}</Text> : (
                            <Pressable accessibilityLabel="Report message" hitSlop={10} onPress={() => void safetyAction(message)}>
                              <Text style={styles.reportText}>Report</Text>
                            </Pressable>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <View accessibilityLiveRegion="polite" style={styles.typingLine}>
                <Text style={styles.typingText}>{typing.length ? `${typing[0].name} is typing…` : ' '}</Text>
              </View>
              <View style={styles.pickupSection}>
                <View style={styles.pickupHeading}>
                  <FontAwesome6 color={palette.accentDeep} name="location-dot" size={12} />
                  <View style={styles.pickupHeadingCopy}>
                    <Text style={styles.pickupTitle}>Verified pickup</Text>
                    <Text style={styles.pickupSubtitle}>Exact details stay out of messages and expire automatically.</Text>
                  </View>
                </View>
                {activePickup?.state === 'authorized' && pickupDetail ? (
                  <View style={styles.pickupDetail}>
                    <View style={styles.pickupDetailCopy}>
                      <Text style={styles.pickupLocation}>{pickupDetail.label}</Text>
                      <Text style={styles.pickupAddress}>{pickupDetail.address}, {pickupDetail.city}, {pickupDetail.region}{pickupDetail.postalCode ? ` ${pickupDetail.postalCode}` : ''}</Text>
                      <Text style={styles.pickupWindow}>{pickupTime.format(new Date(pickupDetail.startsAt))}–{pickupTime.format(new Date(pickupDetail.endsAt))} · expires {sentTime.format(new Date(pickupDetail.expiresAt))}</Text>
                    </View>
                    <Pressable accessibilityLabel="Get pickup directions" accessibilityRole="button" onPress={() => void openPickupDirections()} style={styles.pickupPrimary}>
                      <Text style={styles.pickupPrimaryText}>Get directions</Text>
                      <FontAwesome6 color="#FFFFFF" name="diamond-turn-right" size={11} />
                    </Pressable>
                    <Pressable accessibilityRole="button" disabled={pickupBusy} onPress={() => void resolvePickup(activePickup)} style={styles.pickupLink}>
                      <Text style={styles.pickupLinkText}>{pickupRole === 'merchant' ? 'Revoke details' : 'Cancel pickup'}</Text>
                    </Pressable>
                  </View>
                ) : activePickup?.state === 'authorized' ? (
                  <View style={styles.pickupDetail}>
                    <Text accessibilityLiveRegion="polite" style={styles.pickupWarning}>Exact details are unavailable or expired. They have not been copied into this chat.</Text>
                    <Pressable accessibilityRole="button" disabled={pickupBusy} onPress={() => void resolvePickup(activePickup)} style={styles.pickupLink}>
                      <Text style={styles.pickupLinkText}>{pickupRole === 'merchant' ? 'Revoke request' : 'Cancel request'}</Text>
                    </Pressable>
                  </View>
                ) : activePickup?.state === 'pending' && pickupRole === 'merchant' ? (
                  <View style={styles.pickupDetail}>
                    <Text style={styles.pickupStatus}>Customer requested {pickupTime.format(new Date(activePickup.startsAt))}–{pickupTime.format(new Date(activePickup.endsAt))}.</Text>
                    {pickupOptions.length ? pickupOptions.slice(0, 3).map((option) => (
                      <Pressable accessibilityRole="button" disabled={pickupBusy} key={option.id} onPress={() => void authorizePickup(activePickup, option)} style={styles.pickupOption}>
                        <View style={styles.pickupDetailCopy}>
                          <Text style={styles.pickupLocation}>{option.label}</Text>
                          <Text style={styles.pickupAddress}>{option.city}, {option.region} · staff-approved public location</Text>
                        </View>
                        <FontAwesome6 color={palette.accentDeep} name="arrow-right" size={11} />
                      </Pressable>
                    )) : <Text style={styles.pickupWarning}>Business pickup-location setup and staff approval are required before details can be released.</Text>}
                    {pickupOptions.length > 3 ? <Text style={styles.pickupStatus}>Showing the first 3 of {pickupOptions.length} approved locations.</Text> : null}
                    <Pressable accessibilityRole="button" disabled={pickupBusy} onPress={() => void resolvePickup(activePickup)} style={styles.pickupLink}><Text style={styles.pickupLinkText}>Decline request</Text></Pressable>
                  </View>
                ) : activePickup?.state === 'pending' ? (
                  <View style={styles.pickupDetail}>
                    <Text style={styles.pickupStatus}>Waiting for the seller to approve a public pickup location for {pickupTime.format(new Date(activePickup.startsAt))}.</Text>
                    <Pressable accessibilityRole="button" disabled={pickupBusy} onPress={() => void resolvePickup(activePickup)} style={styles.pickupLink}><Text style={styles.pickupLinkText}>Cancel request</Text></Pressable>
                  </View>
                ) : pickupRole === 'customer' && !threadClosed ? (
                  <View style={styles.pickupPresets}>
                    {[60, 120, 24 * 60].map((minutes) => (
                      <Pressable accessibilityRole="button" disabled={pickupBusy} key={minutes} onPress={() => void requestPickupWindow(minutes)} style={styles.pickupPreset}>
                        <Text style={styles.pickupPresetText}>{minutes === 60 ? 'In 1 hour' : minutes === 120 ? 'In 2 hours' : 'Tomorrow'}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.pickupStatus}>{threadClosed ? 'Pickup controls are closed with this conversation.' : 'Waiting for the customer to request a pickup window.'}</Text>
                )}
              </View>
              {photos.length ? (
                <View style={styles.photoTray}>
                  {photos.map((photo) => (
                    <View key={photo.assetId} style={styles.pendingPhotoWrap}>
                      <Image source={{ uri: photo.uri }} style={styles.pendingPhoto} />
                      <View style={[styles.photoState, photo.state === 'approved' && styles.photoStateApproved, photo.state === 'rejected' && styles.photoStateRejected]}>
                        <Text style={styles.photoStateText}>{photo.state === 'pending' ? 'Safety check' : photo.state}</Text>
                      </View>
                      <Pressable accessibilityLabel="Remove photo" onPress={() => setPhotos((current) => current.filter((entry) => entry.assetId !== photo.assetId))} style={styles.removePhoto}>
                        <FontAwesome6 color="#FFFFFF" name="xmark" size={9} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
              {threadClosed ? <Text accessibilityLiveRegion="polite" style={styles.closedNotice}>This conversation is closed. Its shared history remains available for safety and account records.</Text> : null}
              {draftSafetyIssue ? <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.safetyWarning}>{chatSafetyMessage(draftSafetyIssue)}</Text> : null}
              {error ? <Text accessibilityRole="alert" style={styles.inlineError}>{error}</Text> : null}
              <View style={styles.composer}>
                <Pressable accessibilityLabel="Attach a photo" accessibilityRole="button" accessibilityState={{ disabled: !conversation || threadClosed || photos.length >= 4 }} disabled={!conversation || threadClosed || photos.length >= 4} onPress={() => void pickPhoto()} style={[styles.attachButton, (!conversation || threadClosed || photos.length >= 4) && styles.attachButtonDisabled]}>
                  <FontAwesome6 color={palette.ink} name="camera" size={13} />
                </Pressable>
                <TextInput
                  accessibilityLabel="Message"
                  editable={!threadClosed}
                  multiline
                  onChangeText={changeDraft}
                  placeholder={threadClosed ? 'Conversation closed' : 'Write a short, professional message'}
                  placeholderTextColor={palette.mutedLight}
                  style={styles.input}
                  value={draft}
                />
                <Pressable accessibilityLabel="Send message" accessibilityRole="button" accessibilityState={{ disabled: Boolean(draftSafetyIssue) || threadClosed || (!draft.trim() && !photos.some((photo) => photo.state === 'approved')) || photos.some((photo) => photo.state === 'pending') || sending }} disabled={Boolean(draftSafetyIssue) || threadClosed || (!draft.trim() && !photos.some((photo) => photo.state === 'approved')) || photos.some((photo) => photo.state === 'pending') || sending} onPress={() => void send()} style={[styles.sendButton, (Boolean(draftSafetyIssue) || threadClosed || (!draft.trim() && !photos.some((photo) => photo.state === 'approved')) || photos.some((photo) => photo.state === 'pending') || sending) && styles.sendDisabled]}>
                  {sending ? <ActivityIndicator color="#FFFFFF" size="small" /> : <FontAwesome6 color="#FFFFFF" name="paper-plane" size={14} solid />}
                </Pressable>
              </View>
            </>
          )}
        </KeyboardAvoidingView>
      </PageShell>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 620 },
  header: { alignItems: 'center', backgroundColor: palette.surface, borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.md, padding: spacing.md },
  headerCopy: { flex: 1, gap: 2 },
  headerTitle: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  headerMeta: { color: palette.muted, fontSize: 9 },
  iconButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 40, justifyContent: 'center', width: 40 },
  iconButtonDisabled: { opacity: 0.35 },
  privacyBanner: { alignItems: 'flex-start', backgroundColor: palette.successSoft, flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  privacyText: { color: palette.success, flex: 1, fontSize: 9, lineHeight: 14 },
  center: { alignItems: 'center', flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  centerTitle: { color: palette.ink, fontSize: 17, fontWeight: '900' },
  centerBody: { color: palette.muted, fontSize: 11, textAlign: 'center' },
  messages: { gap: spacing.lg, padding: spacing.lg },
  messageRow: { alignItems: 'flex-end', flexDirection: 'row', gap: spacing.sm },
  messageRowMine: { justifyContent: 'flex-end' },
  avatar: { borderRadius: 999, height: 30, width: 30 },
  avatarFallback: { alignItems: 'center', backgroundColor: palette.dark, borderRadius: 999, height: 30, justifyContent: 'center', width: 30 },
  avatarText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  bubbleWrap: { alignItems: 'flex-start', maxWidth: '78%' },
  bubbleWrapMine: { alignItems: 'flex-end' },
  senderName: { color: palette.muted, fontSize: 9, fontWeight: '800', marginBottom: 4 },
  bubble: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: 18, borderBottomLeftRadius: 5, borderWidth: 1, gap: spacing.sm, overflow: 'hidden', padding: spacing.md },
  bubbleMine: { backgroundColor: palette.dark, borderBottomLeftRadius: 18, borderBottomRightRadius: 5, borderColor: palette.dark },
  body: { color: palette.ink, fontSize: 13, lineHeight: 19 },
  bodyMine: { color: '#FFFFFF' },
  attachment: { borderRadius: radii.md, height: 220, maxWidth: 320, resizeMode: 'cover', width: 260 },
  metaLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: 5 },
  metaLineMine: { justifyContent: 'flex-end' },
  messageTime: { color: palette.mutedLight, fontSize: 8 },
  readState: { color: palette.success, fontSize: 8, fontWeight: '800' },
  reportText: { color: palette.accentDeep, fontSize: 8, fontWeight: '800' },
  typingLine: { minHeight: 24, paddingHorizontal: spacing.lg },
  typingText: { color: palette.muted, fontSize: 9, fontStyle: 'italic' },
  pickupSection: { borderTopColor: palette.line, borderTopWidth: 1, gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  pickupHeading: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
  pickupHeadingCopy: { flex: 1, gap: 2 },
  pickupTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  pickupSubtitle: { color: palette.muted, fontSize: 8, lineHeight: 12 },
  pickupDetail: { gap: spacing.sm },
  pickupDetailCopy: { flex: 1, gap: 2 },
  pickupLocation: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  pickupAddress: { color: palette.muted, fontSize: 9, lineHeight: 13 },
  pickupWindow: { color: palette.success, fontSize: 8, fontWeight: '700', lineHeight: 12 },
  pickupStatus: { color: palette.muted, fontSize: 9, lineHeight: 14 },
  pickupWarning: { color: palette.accentDeep, fontSize: 9, lineHeight: 14 },
  pickupPrimary: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: palette.accentDeep, borderRadius: 999, flexDirection: 'row', gap: spacing.sm, minHeight: 40, paddingHorizontal: spacing.md },
  pickupPrimaryText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  pickupLink: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  pickupLinkText: { color: palette.accentDeep, fontSize: 9, fontWeight: '800', textDecorationLine: 'underline' },
  pickupOption: { alignItems: 'center', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.md, minHeight: 48, paddingVertical: spacing.sm },
  pickupPresets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pickupPreset: { borderColor: palette.line, borderRadius: 999, borderWidth: 1, minHeight: 38, justifyContent: 'center', paddingHorizontal: spacing.md },
  pickupPresetText: { color: palette.ink, fontSize: 9, fontWeight: '800' },
  inlineError: { color: palette.accentDeep, fontSize: 10, paddingHorizontal: spacing.lg, paddingVertical: 4 },
  safetyWarning: { backgroundColor: palette.accentSoft, color: palette.accentDeep, fontSize: 10, fontWeight: '700', lineHeight: 15, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  closedNotice: { backgroundColor: palette.bg, color: palette.muted, fontSize: 10, lineHeight: 15, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  photoTray: { backgroundColor: palette.surface, borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  pendingPhotoWrap: { position: 'relative' },
  pendingPhoto: { borderRadius: radii.md, height: 72, width: 72 },
  photoState: { backgroundColor: 'rgba(25,29,27,0.78)', borderRadius: 999, bottom: 4, left: 4, paddingHorizontal: 6, paddingVertical: 3, position: 'absolute' },
  photoStateApproved: { backgroundColor: palette.success },
  photoStateRejected: { backgroundColor: palette.accentDeep },
  photoStateText: { color: '#FFFFFF', fontSize: 7, fontWeight: '900', textTransform: 'capitalize' },
  removePhoto: { alignItems: 'center', backgroundColor: palette.dark, borderRadius: 999, height: 20, justifyContent: 'center', position: 'absolute', right: -5, top: -5, width: 20 },
  composer: { alignItems: 'flex-end', backgroundColor: palette.surface, borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  attachButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 46, justifyContent: 'center', width: 46 },
  attachButtonDisabled: { opacity: 0.4 },
  input: { backgroundColor: palette.bg, borderColor: palette.line, borderRadius: 20, borderWidth: 1, color: palette.ink, flex: 1, fontSize: 13, maxHeight: 120, minHeight: 46, paddingHorizontal: spacing.lg, paddingVertical: 12 },
  sendButton: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 999, height: 46, justifyContent: 'center', minWidth: 46, paddingHorizontal: spacing.md },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
});
