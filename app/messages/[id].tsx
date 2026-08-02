import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
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
import {
  getMarketplaceMessages,
  getMarketplaceTyping,
  listMarketplaceConversations,
  markMarketplaceConversationRead,
  reportMarketplaceMessage,
  sendMarketplaceMessage,
  setMarketplaceTyping,
} from '@/lib/marketplace-chat';
import { blockUser } from '@/lib/marketplace-api';
import { mediaProcessingStates, stageMediaUpload } from '@/lib/media-upload';
import { confirmAction, showMessage } from '@/lib/platform-dialog';
import type { MarketplaceChatMessage, MarketplaceConversation, MarketplaceTypingMember } from '@/types/chat';

const sentTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const auth = useAuth();
  const focused = useIsFocused();
  const scrollRef = useRef<ScrollView | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messages, setMessages] = useState<MarketplaceChatMessage[]>([]);
  const [conversation, setConversation] = useState<MarketplaceConversation | null>(null);
  const [typing, setTyping] = useState<MarketplaceTypingMember[]>([]);
  const [photos, setPhotos] = useState<{ assetId: string; uri: string; state: 'pending' | 'approved' | 'rejected' }[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!id) return;
    if (!quiet) setLoading(true);
    const [messageResult, typingMembers] = await Promise.all([
      getMarketplaceMessages(id),
      getMarketplaceTyping(id),
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
    if (!id || (!body && !approvedAssets.length) || photos.some((photo) => photo.state === 'pending') || sending) return;
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
    if (!id || !conversation || photos.length >= 4) return;
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
    const counterpart = messages.find((message) => message.sender.username !== auth.account?.username)?.sender;
    if (!counterpart) return;
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
              <Text style={styles.headerMeta}>{conversation ? `@${conversation.counterpart.username} · ${conversation.businessName}` : 'Encrypted in transit · participant-only access'}</Text>
            </View>
            <Pressable accessibilityLabel="Block conversation member" accessibilityRole="button" onPress={() => void blockCounterpart()} style={styles.iconButton}>
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
                        {!mine ? <Text style={styles.senderName}>{message.sender.name} · @{message.sender.username}</Text> : null}
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
              {error ? <Text accessibilityRole="alert" style={styles.inlineError}>{error}</Text> : null}
              <View style={styles.composer}>
                <Pressable accessibilityLabel="Attach a photo" accessibilityRole="button" disabled={!conversation || photos.length >= 4} onPress={() => void pickPhoto()} style={styles.attachButton}>
                  <FontAwesome6 color={palette.ink} name="camera" size={13} />
                </Pressable>
                <TextInput
                  accessibilityLabel="Message"
                  multiline
                  onChangeText={changeDraft}
                  placeholder="Write a short, professional message"
                  placeholderTextColor={palette.mutedLight}
                  style={styles.input}
                  value={draft}
                />
                <Pressable accessibilityLabel="Send message" accessibilityRole="button" disabled={(!draft.trim() && !photos.some((photo) => photo.state === 'approved')) || photos.some((photo) => photo.state === 'pending') || sending} onPress={() => void send()} style={[styles.sendButton, ((!draft.trim() && !photos.some((photo) => photo.state === 'approved')) || photos.some((photo) => photo.state === 'pending') || sending) && styles.sendDisabled]}>
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
  inlineError: { color: palette.accentDeep, fontSize: 10, paddingHorizontal: spacing.lg, paddingVertical: 4 },
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
  input: { backgroundColor: palette.bg, borderColor: palette.line, borderRadius: 20, borderWidth: 1, color: palette.ink, flex: 1, fontSize: 13, maxHeight: 120, minHeight: 46, paddingHorizontal: spacing.lg, paddingVertical: 12 },
  sendButton: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 999, height: 46, justifyContent: 'center', minWidth: 46, paddingHorizontal: spacing.md },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
});
