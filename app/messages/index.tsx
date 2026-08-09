import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { listMarketplaceConversations } from '@/lib/marketplace-chat';
import type { MarketplaceConversation } from '@/types/chat';

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function MessagesScreen() {
  const auth = useAuth();
  const [conversations, setConversations] = useState<MarketplaceConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    if (auth.status !== 'authenticated') {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    void listMarketplaceConversations().then((result) => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setError(null);
      setConversations(result.data ?? []);
    });
    return () => { active = false; };
  }, [auth.status]));

  return (
    <FocusAwareScreen>
      <PageShell>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.topbar}>
            <BrandMark compact />
            <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}>
              <FontAwesome6 color={palette.ink} name="xmark" size={15} />
            </Pressable>
          </View>
          <View style={styles.heading}>
            <Text style={styles.eyebrow}>PRIVATE MARKETPLACE CHAT</Text>
            <Text accessibilityRole="header" style={styles.title}>Messages</Text>
            <Text style={styles.subtitle}>Coordinate directly with verified Neighborhood Kitchens and participating pop-ups.</Text>
          </View>

          {auth.status !== 'authenticated' ? (
            <View style={styles.empty}>
              <FontAwesome6 color={palette.accentDeep} name="lock" size={22} />
              <Text style={styles.emptyTitle}>Sign in to use secure chat</Text>
              <Text style={styles.emptyBody}>Messages are available only to authenticated, non-blocked participants.</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/auth')} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Sign in</Text>
              </Pressable>
            </View>
          ) : loading ? (
            <View accessibilityLiveRegion="polite" style={styles.loading}>
              <ActivityIndicator color={palette.accentDeep} />
              <Text style={styles.emptyBody}>Loading private conversations…</Text>
            </View>
          ) : error ? (
            <View accessibilityRole="alert" style={styles.empty}>
              <FontAwesome6 color={palette.accentDeep} name="triangle-exclamation" size={21} />
              <Text style={styles.emptyTitle}>Messages unavailable</Text>
              <Text style={styles.emptyBody}>{error}</Text>
            </View>
          ) : conversations.length ? (
            <View style={styles.list}>
              {conversations.map((conversation) => (
                <Pressable
                  accessibilityLabel={`Open conversation with ${conversation.counterpart.name} for ${conversation.businessName}`}
                  accessibilityRole="button"
                  key={conversation.id}
                  onPress={() => router.push({ pathname: '/messages/[id]', params: { id: conversation.id } } as never)}
                  style={styles.row}>
                  {conversation.counterpart.avatarUrl ? (
                    <Image source={{ uri: conversation.counterpart.avatarUrl }} style={styles.avatar} />
                  ) : (
                    <View style={styles.avatarFallback}>
                      <Text style={styles.avatarText}>{conversation.counterpart.name.slice(0, 1).toUpperCase()}</Text>
                    </View>
                  )}
                  <View style={styles.rowCopy}>
                    <View style={styles.rowTitleLine}>
                      <Text numberOfLines={1} style={styles.rowTitle}>{conversation.counterpart.name}</Text>
                      {conversation.unreadCount ? <View style={styles.unread}><Text style={styles.unreadText}>{Math.min(99, conversation.unreadCount)}</Text></View> : null}
                    </View>
                    <Text numberOfLines={1} style={styles.identity}>@{conversation.counterpart.username} · {conversation.businessName}</Text>
                    <Text numberOfLines={2} style={styles.preview}>{conversation.lastMessage || 'Start the conversation.'}</Text>
                    <Text style={styles.timestamp}>{time.format(new Date(conversation.lastMessageAt ?? conversation.createdAt))}</Text>
                  </View>
                  <FontAwesome6 color={palette.mutedLight} name="chevron-right" size={12} />
                </Pressable>
              ))}
            </View>
          ) : (
            <View style={styles.empty}>
              <FontAwesome6 color={palette.success} name="comments" size={23} />
              <Text style={styles.emptyTitle}>No conversations yet</Text>
              <Text style={styles.emptyBody}>Open an eligible listing and choose Message seller.</Text>
            </View>
          )}
          <View style={styles.safetyNote}>
            <FontAwesome6 color={palette.success} name="shield-halved" size={14} />
            <Text style={styles.safetyText}>Never send payment credentials, identity documents, or a home address in chat. Report or block unsafe behavior.</Text>
          </View>
        </ScrollView>
      </PageShell>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl, paddingBottom: 80, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  iconButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 40, justifyContent: 'center', width: 40 },
  heading: { gap: 6, maxWidth: 680 },
  eyebrow: { color: palette.accentDeep, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  title: { color: palette.ink, fontSize: 34, fontWeight: '900', letterSpacing: -1 },
  subtitle: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  loading: { alignItems: 'center', gap: spacing.md, padding: spacing.xxxl },
  list: { borderColor: palette.line, borderRadius: radii.xl, borderWidth: 1, overflow: 'hidden' },
  row: { alignItems: 'center', backgroundColor: palette.surface, borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.md, minHeight: 112, padding: spacing.lg },
  avatar: { borderRadius: 999, height: 48, width: 48 },
  avatarFallback: { alignItems: 'center', backgroundColor: palette.dark, borderRadius: 999, height: 48, justifyContent: 'center', width: 48 },
  avatarText: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  rowCopy: { flex: 1, gap: 3 },
  rowTitleLine: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  rowTitle: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: '900' },
  identity: { color: palette.muted, fontSize: 10, fontWeight: '700' },
  preview: { color: palette.ink, fontSize: 12, lineHeight: 17 },
  timestamp: { color: palette.mutedLight, fontSize: 9 },
  unread: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 999, minWidth: 22, paddingHorizontal: 6, paddingVertical: 3 },
  unreadText: { color: '#FFFFFF', fontSize: 9, fontWeight: '900' },
  empty: { alignItems: 'flex-start', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.xl, borderWidth: 1, gap: spacing.md, padding: spacing.xl },
  emptyTitle: { color: palette.ink, fontSize: 17, fontWeight: '900' },
  emptyBody: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  primaryButton: { backgroundColor: palette.dark, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 12 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  safetyNote: { alignItems: 'flex-start', backgroundColor: palette.successSoft, borderRadius: radii.lg, flexDirection: 'row', gap: spacing.md, padding: spacing.lg },
  safetyText: { color: palette.success, flex: 1, fontSize: 10, lineHeight: 16 },
});
