import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { BrandMark } from "@/components/brand-mark";
import { FocusAwareScreen } from "@/components/focus-aware-screen";
import { PageShell } from "@/components/page-shell";
import { palette, radii, spacing } from "@/constants/theme";
import { useAuth } from "@/context/auth-context";
import {
  loadBusinessMarketplace,
  type MarketplaceControls,
  type MeetingPlaceSuggestion,
  type NeighborhoodPickupSettings,
  setBusinessMarketplaceChat,
  setBusinessMeetingRoutes,
  setNeighborhoodResidencePickup,
} from "@/lib/business-marketplace";
import { confirmAction } from "@/lib/platform-dialog";

type Notice = { tone: "error" | "success"; text: string };

type BusinessMarketplaceWorkspaceProps = {
  businessId: string;
  expectedAccountId: string | null;
};

export default function BusinessMarketplaceScreen() {
  const auth = useAuth();
  const params = useLocalSearchParams<{ businessId?: string | string[] }>();
  const businessId = Array.isArray(params.businessId)
    ? params.businessId[0] ?? ""
    : params.businessId ?? "";
  const expectedAccountId = auth.status === "authenticated"
    ? auth.account?.id ?? null
    : null;
  const workspaceKey = auth.status === "authenticated"
    ? `${expectedAccountId ?? "missing"}:${auth.securityStatus}:${
      auth.assuranceLevel ?? "none"
    }:${auth.mfaEnrolled}:${businessId}`
    : `${auth.status}:${businessId}`;

  return (
    <BusinessMarketplaceWorkspace
      businessId={businessId}
      expectedAccountId={expectedAccountId}
      key={workspaceKey}
    />
  );
}

function BusinessMarketplaceWorkspace({
  businessId,
  expectedAccountId,
}: BusinessMarketplaceWorkspaceProps) {
  const auth = useAuth();
  const [controls, setControls] = useState<MarketplaceControls | null>(null);
  const [settings, setSettings] = useState<NeighborhoodPickupSettings | null>(
    null,
  );
  const [suggestions, setSuggestions] = useState<MeetingPlaceSuggestion[]>([]);
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  const secureSession = Boolean(expectedAccountId) &&
    auth.status === "authenticated" &&
    auth.securityStatus === "ready" &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === "aal2";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    if (!secureSession || !businessId || !expectedAccountId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setNotice(null);
    const result = await loadBusinessMarketplace(expectedAccountId, businessId);
    if (!mounted.current || generation !== requestGeneration.current) return;
    setLoading(false);
    if (!result.ok) {
      setControls(null);
      setSettings(null);
      setSuggestions([]);
      setSelectedRoutes([]);
      setNotice({ tone: "error", text: result.reason });
      return;
    }
    setControls(result.data.controls);
    setSettings(result.data.neighborhoodSettings);
    setSuggestions(result.data.meetingSuggestions);
    setSelectedRoutes(
      result.data.meetingSuggestions
        .filter((entry) => entry.selectedOrdinal !== null)
        .sort((a, b) => (a.selectedOrdinal ?? 9) - (b.selectedOrdinal ?? 9))
        .map((entry) => entry.publicId),
    );
  }, [businessId, expectedAccountId, secureSession]);

  useEffect(() => {
    if (!secureSession || !businessId || !expectedAccountId) {
      requestGeneration.current += 1;
      setLoading(false);
      setBusy(null);
      setControls(null);
      setSettings(null);
      setSuggestions([]);
      setSelectedRoutes([]);
      return;
    }
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [businessId, expectedAccountId, load, secureSession]);

  const toggleChat = async (enabled: boolean) => {
    if (!controls || busy || !secureSession || !expectedAccountId) return;
    const generation = ++requestGeneration.current;
    setLoading(false);
    setBusy("chat");
    setNotice(null);
    const result = await setBusinessMarketplaceChat(
      expectedAccountId,
      controls.businessId,
      enabled,
    );
    if (!mounted.current || generation !== requestGeneration.current) return;
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.reason });
      return;
    }
    setControls({ ...controls, chatEnabled: result.data });
    setNotice({
      tone: "success",
      text: result.data
        ? "New customer chats are allowed."
        : "New chats are paused. Existing conversations stay available.",
    });
  };

  const toggleRoute = (publicId: string) =>
    setSelectedRoutes((current) => (
      current.includes(publicId)
        ? current.filter((id) => id !== publicId)
        : current.length < 3
        ? [...current, publicId]
        : current
    ));

  const saveRoutes = async () => {
    if (!controls || busy || !secureSession || !expectedAccountId) return;
    const generation = ++requestGeneration.current;
    setLoading(false);
    setBusy("routes");
    setNotice(null);
    const result = await setBusinessMeetingRoutes(
      expectedAccountId,
      controls.businessId,
      selectedRoutes,
    );
    if (!mounted.current || generation !== requestGeneration.current) return;
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.reason });
      return;
    }
    setNotice({
      tone: "success",
      text: `${result.data} public meetup places saved.`,
    });
    await load();
  };

  const toggleResidence = async (enabled: boolean) => {
    if (!controls || !settings || busy || !secureSession || !expectedAccountId) {
      return;
    }
    const intentGeneration = requestGeneration.current;
    if (
      enabled && !(await confirmAction({
        title: "Enable residence pickup?",
        message:
          "A public shopping center is the recommended choice. Your address stays out of your listing and chat. It is released only in an expiring pickup card after the customer accepts the caution and you confirm that request. Spottr does not inspect or guarantee the location or transaction.",
        confirmLabel: "Enable carefully",
      }))
    ) return;
    if (
      !mounted.current ||
      intentGeneration !== requestGeneration.current ||
      !secureSession ||
      !expectedAccountId
    ) return;
    const generation = ++requestGeneration.current;
    setLoading(false);
    setBusy("residence");
    setNotice(null);
    const result = await setNeighborhoodResidencePickup(
      expectedAccountId,
      controls.businessId,
      enabled,
    );
    if (!mounted.current || generation !== requestGeneration.current) return;
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.reason });
      return;
    }
    setSettings({ ...settings, residencePickupEnabled: result.data });
    setNotice({
      tone: "success",
      text: result.data
        ? "Residence pickup is available as the final caution-marked choice."
        : "Residence pickup is disabled and active address cards were revoked.",
    });
  };

  if (!secureSession) {
    return (
      <FocusAwareScreen>
        <ScrollView
          contentContainerStyle={styles.content}
          style={styles.screen}
        >
          <PageShell narrow>
            <View style={styles.topbar}>
              <BrandMark />
            </View>
            <View style={styles.gate}>
              <FontAwesome6
                color={palette.accentDeep}
                name="shield-halved"
                size={24}
              />
              <Text accessibilityRole="header" style={styles.gateTitle}>
                Private meetup controls
              </Text>
              <Text style={styles.copy}>
                Sign in as an owner or manager and verify a current
                authenticator code.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  router.push(
                    auth.status === "anonymous" ? "/auth" : "/security",
                  )}
                style={styles.primary}
              >
                <Text style={styles.primaryText}>
                  {auth.status === "anonymous" ? "Sign in" : "Verify security"}
                </Text>
              </Pressable>
            </View>
          </PageShell>
        </ScrollView>
      </FocusAwareScreen>
    );
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <BrandMark />
            <Pressable
              accessibilityLabel="Close meetup controls"
              accessibilityRole="button"
              onPress={() => router.back()}
              style={styles.close}
            >
              <FontAwesome6 color={palette.ink} name="xmark" size={14} />
            </Pressable>
          </View>
          <View style={styles.intro}>
            <Text style={styles.eyebrow}>Meetup preferences</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Public first. Private by design.
            </Text>
            <Text style={styles.copy}>
              Control new chats and, for Neighborhood Kitchen, give customers
              two or three current public places to choose from.
            </Text>
          </View>
          {notice
            ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole={notice.tone === "error"
                  ? "alert"
                  : undefined}
                style={[
                  styles.notice,
                  notice.tone === "success" && styles.noticeGood,
                ]}
              >
                <Text
                  style={[
                    styles.noticeText,
                    notice.tone === "success" && styles.noticeGoodText,
                  ]}
                >
                  {notice.text}
                </Text>
              </View>
            )
            : null}
          {loading
            ? (
              <View style={styles.loading}>
                <ActivityIndicator color={palette.accentDeep} />
                <Text style={styles.copy}>Loading protected controls…</Text>
              </View>
            )
            : controls
            ? (
              <>
                <View style={styles.section}>
                  <View style={styles.sectionHeading}>
                    <View style={styles.headingCopy}>
                      <Text style={styles.kicker}>01 · Customer contact</Text>
                      <Text style={styles.sectionTitle}>
                        {controls.businessName}
                      </Text>
                      <Text style={styles.copy}>
                        {controls.chatRequired
                          ? "Private chat is required for Neighborhood Kitchen."
                          : "Control whether customers can start a new chat. Existing conversations remain available."}
                      </Text>
                    </View>
                    <Switch
                      accessibilityLabel="Allow new customer chats"
                      disabled={!controls.canToggleChat || busy === "chat"}
                      onValueChange={(value) => void toggleChat(value)}
                      trackColor={{ false: palette.line, true: palette.mint }}
                      thumbColor={controls.chatEnabled
                        ? palette.success
                        : palette.mutedLight}
                      value={controls.chatEnabled}
                    />
                  </View>
                  <View style={styles.statusLine}>
                    <View
                      style={[
                        styles.dot,
                        controls.chatEnabled && styles.dotGood,
                      ]}
                    />
                    <Text style={styles.statusText}>
                      {controls.chatEnabled
                        ? "New chats allowed"
                        : "New chats paused"}
                    </Text>
                  </View>
                </View>
                {controls.businessKind === "home_kitchen"
                  ? (
                    <>
                      <View style={styles.section}>
                        <Text style={styles.kicker}>
                          02 · Public meetup places
                        </Text>
                        <Text style={styles.sectionTitle}>
                          Choose 2–3 places
                        </Text>
                        <Text style={styles.copy}>
                          Suggestions come from a licensed, current provider
                          feed. Customers never see distance or direction from
                          your private service location.
                        </Text>
                        {!suggestions.length
                          ? (
                            <Text style={styles.empty}>
                              No current provider-sourced public places are
                              available nearby. Meetup requests remain
                              unavailable until the feed is populated.
                            </Text>
                          )
                          : suggestions.map((place) => {
                            const selected = selectedRoutes.includes(
                              place.publicId,
                            );
                            return (
                              <Pressable
                                accessibilityRole="checkbox"
                                aria-checked={selected}
                                accessibilityState={{
                                  checked: selected,
                                  disabled: !selected &&
                                    selectedRoutes.length >= 3,
                                }}
                                disabled={!selected &&
                                  selectedRoutes.length >= 3}
                                key={place.publicId}
                                onPress={() => toggleRoute(place.publicId)}
                                style={[
                                  styles.site,
                                  selected && styles.siteSelected,
                                ]}
                              >
                                <View style={styles.headingCopy}>
                                  <Text style={styles.siteTitle}>
                                    {place.label}
                                  </Text>
                                  <Text style={styles.address}>
                                    {place.addressLine} · {place.city},{" "}
                                    {place.region} {place.postalCode ?? ""}
                                  </Text>
                                  <Text style={styles.coordinates}>
                                    {place.distanceMeters < 1000
                                      ? `${Math.round(place.distanceMeters)} m`
                                      : `${
                                        (place.distanceMeters / 1000).toFixed(1)
                                      } km`}{" "}
                                    from your private service pin · seller view
                                    only
                                  </Text>
                                </View>
                                <FontAwesome6
                                  color={selected
                                    ? palette.success
                                    : palette.mutedLight}
                                  name={selected ? "circle-check" : "circle"}
                                  size={16}
                                />
                              </Pressable>
                            );
                          })}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{
                            disabled: selectedRoutes.length < 2 ||
                              Boolean(busy),
                          }}
                          disabled={selectedRoutes.length < 2 || Boolean(busy)}
                          onPress={() => void saveRoutes()}
                          style={[
                            styles.primary,
                            (selectedRoutes.length < 2 || Boolean(busy)) &&
                            styles.disabled,
                          ]}
                        >
                          <Text style={styles.primaryText}>
                            Save {selectedRoutes.length} places
                          </Text>
                        </Pressable>
                      </View>
                      <View style={styles.section}>
                        <View style={styles.sectionHeading}>
                          <View style={styles.headingCopy}>
                            <Text style={styles.kicker}>
                              03 · Optional residence
                            </Text>
                            <Text style={styles.sectionTitle}>
                              Residence pickup
                            </Text>
                            <Text style={styles.copy}>
                              Off by default. The exact address is never public
                              and expires no later than two hours after the
                              meetup window.
                            </Text>
                          </View>
                          <Switch
                            accessibilityLabel="Residence pickup enabled"
                            disabled={!settings?.serviceLocationReady ||
                              Boolean(busy)}
                            onValueChange={(value) =>
                              void toggleResidence(value)}
                            trackColor={{
                              false: palette.line,
                              true: palette.warningSoft,
                            }}
                            thumbColor={settings?.residencePickupEnabled
                              ? palette.warning
                              : palette.mutedLight}
                            value={settings?.residencePickupEnabled ?? false}
                          />
                        </View>
                        {!settings?.serviceLocationReady
                          ? (
                            <Text style={styles.empty}>
                              Complete a usable private primary address before
                              enabling this option.
                            </Text>
                          )
                          : (
                            <Text style={styles.statusText}>
                              {settings.residencePickupEnabled
                                ? "Enabled as the final caution-marked choice."
                                : "Off by default."}
                            </Text>
                          )}
                      </View>
                    </>
                  )
                  : (
                    <View style={styles.section}>
                      <Text style={styles.kicker}>02 · Public location</Text>
                      <Text style={styles.sectionTitle}>
                        Use your published location
                      </Text>
                      <Text style={styles.copy}>
                        Pop-up customers use the public location on your
                        listing. Chat is for timing and availability; Spottr
                        does not collect a second staff-approved pickup address.
                      </Text>
                    </View>
                  )}
              </>
            )
            : null}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 88, paddingHorizontal: spacing.lg },
  topbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: spacing.md,
  },
  close: {
    alignItems: "center",
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  intro: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: 48 },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: "SpaceMono",
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  title: {
    color: palette.ink,
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: -1.2,
    lineHeight: 38,
  },
  copy: { color: palette.muted, fontSize: 13, lineHeight: 20, maxWidth: 620 },
  gate: { alignItems: "flex-start", gap: spacing.md, paddingVertical: 64 },
  gateTitle: { color: palette.ink, fontSize: 26, fontWeight: "900" },
  notice: {
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  noticeGood: { backgroundColor: palette.successSoft },
  noticeText: { color: palette.accentDeep, fontSize: 12 },
  noticeGoodText: { color: palette.success },
  loading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 120,
  },
  section: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    gap: spacing.md,
    paddingVertical: spacing.xl,
  },
  sectionHeading: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.lg,
    justifyContent: "space-between",
  },
  headingCopy: { flex: 1, gap: 4 },
  kicker: {
    color: palette.accentDeep,
    fontFamily: "SpaceMono",
    fontSize: 9,
    letterSpacing: .7,
    textTransform: "uppercase",
  },
  sectionTitle: { color: palette.ink, fontSize: 19, fontWeight: "900" },
  statusLine: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  dot: {
    backgroundColor: palette.mutedLight,
    borderRadius: 99,
    height: 7,
    width: 7,
  },
  dotGood: { backgroundColor: palette.success },
  statusText: { color: palette.muted, fontSize: 11, fontWeight: "700" },
  empty: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  site: {
    alignItems: "center",
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    minHeight: 76,
    paddingVertical: spacing.md,
  },
  siteSelected: {
    backgroundColor: palette.successSoft,
    borderRadius: radii.sm,
    borderTopColor: palette.successSoft,
    paddingHorizontal: spacing.md,
  },
  siteTitle: { color: palette.ink, fontSize: 14, fontWeight: "900" },
  address: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  coordinates: {
    color: palette.mutedLight,
    fontFamily: "SpaceMono",
    fontSize: 8,
    lineHeight: 13,
  },
  primary: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: palette.accentDeep,
    borderRadius: 99,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: spacing.lg,
  },
  primaryText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900" },
  disabled: { opacity: .45 },
});
