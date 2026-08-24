import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ExpoLocation from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  businessDateAfter,
  BusinessConfiguration,
  configurationReadiness,
  createMenuItemDraft,
  createMenuSectionDraft,
  createMobileStopDraft,
  createSpecialHourDraft,
  loadBusinessConfiguration,
  ManagedLocation,
  ManagedMenuItem,
  ManagedMenuSection,
  ManagedMobileStop,
  ManagedSpecialHour,
  ManagedWeeklyHour,
  paymentOptions,
  PaymentKind,
  saveBusinessMenu,
  saveBusinessPayments,
  saveBusinessSpecialHours,
  saveDraftServiceLocations,
  saveDraftMobileStops,
  saveWeeklyHours,
  submitBusinessConfiguration,
} from '@/lib/business-management';
import { confirmAction } from '@/lib/platform-dialog';

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type SectionKey =
  | 'location'
  | 'hours'
  | 'specialHours'
  | 'stops'
  | 'payments'
  | 'menu'
  | 'submit';
type EditableSectionKey = Exclude<SectionKey, 'submit'>;
type Feedback = { type: 'success' | 'error'; text: string; partial?: boolean };
type BusinessSetupContentProps = {
  businessId: string;
  expectedUserId: string | null;
};
type LocationEditor = Omit<ManagedLocation, 'latitude' | 'longitude'> & {
  latitude: string;
  longitude: string;
};

function defaultHours(rows: ManagedWeeklyHour[]) {
  const byDay = new Map(rows.map((row) => [row.weekday, row]));
  return dayNames.map((_, weekday) => {
    const existing = byDay.get(weekday);
    if (existing) return existing;
    const isWeekend = weekday === 0 || weekday === 6;
    return {
      weekday,
      opensAt: isWeekend ? '' : '09:00',
      closesAt: isWeekend ? '' : '17:00',
      isClosed: isWeekend,
      configured: false,
    };
  });
}

function emptyLocation(kind: BusinessConfiguration['business']['kind']): LocationEditor {
  const homeKitchen = kind === 'home_kitchen';
  return {
    id: null,
    isPrimary: true,
    label: homeKitchen ? 'Private pickup area' : 'Primary service location',
    addressLine: '',
    city: '',
    region: '',
    postalCode: '',
    latitude: '',
    longitude: '',
    shareStreetAddress: !homeKitchen && (kind === 'restaurant' || kind === 'cafe_bakery'),
    isApproximate: homeKitchen,
  };
}

function locationEditor(
  location: ManagedLocation | null,
  kind: BusinessConfiguration['business']['kind']
): LocationEditor {
  if (!location) return emptyLocation(kind);
  return {
    ...location,
    latitude: location.latitude === null ? '' : location.latitude.toFixed(6),
    longitude: location.longitude === null ? '' : location.longitude.toFixed(6),
  };
}

function priceDraftsFor(sections: ManagedMenuSection[]) {
  return Object.fromEntries(
    sections.flatMap((section) =>
      section.items.map((item) => [item.id, (item.priceMinor / 100).toFixed(2)])
    )
  );
}

function priceMinorFromDraft(value: string) {
  const match = value.trim().match(/^(\d{1,7})(?:\.(\d{0,2}))?$/);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor <= 100_000_000 ? minor : null;
}

function Field({
  label,
  required,
  detail,
  style,
  ...inputProps
}: TextInputProps & {
  label: string;
  required?: boolean;
  detail?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.field, style]}>
      <View style={styles.fieldLabelRow}>
        <Text style={styles.fieldLabel}>
          {label}
          {required ? <Text style={styles.required}> *</Text> : null}
        </Text>
        {detail ? <Text style={styles.fieldDetail}>{detail}</Text> : null}
      </View>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{ disabled: inputProps.editable === false }}
        autoCorrect={false}
        placeholderTextColor={palette.mutedLight}
        style={[styles.input, inputProps.multiline && styles.multilineInput]}
        {...inputProps}
      />
    </View>
  );
}

function CheckRow({
  checked,
  disabled,
  label,
  detail,
  onPress,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="checkbox"
      aria-checked={checked}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.checkRow,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <FontAwesome6 color="#FFFFFF" name="check" size={10} /> : null}
      </View>
      <View style={styles.checkCopy}>
        <Text style={styles.checkLabel}>{label}</Text>
        {detail ? <Text style={styles.checkDetail}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

function Section({
  icon,
  title,
  detail,
  complete,
  required = true,
  children,
}: {
  icon: keyof typeof FontAwesome6.glyphMap;
  title: string;
  detail: string;
  complete: boolean;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={[styles.sectionIcon, complete && styles.sectionIconComplete]}>
          <FontAwesome6
            color={complete ? palette.success : palette.accentDeep}
            name={complete ? 'check' : icon}
            size={14}
          />
        </View>
        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {title}
          </Text>
          <Text style={styles.sectionDetail}>{detail}</Text>
        </View>
        <Text style={[styles.sectionState, complete && styles.sectionStateComplete]}>
          {complete ? (required ? 'READY' : 'ADDED') : required ? 'REQUIRED' : 'OPTIONAL'}
        </Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function InlineFeedback({ feedback }: { feedback?: Feedback }) {
  if (!feedback) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.feedback, feedback.type === 'success' && styles.feedbackSuccess]}>
      <FontAwesome6
        color={feedback.type === 'success' ? palette.success : palette.accentDeep}
        name={feedback.type === 'success' ? 'circle-check' : 'triangle-exclamation'}
        size={12}
      />
      <Text
        style={[
          styles.feedbackText,
          feedback.type === 'success' && styles.feedbackTextSuccess,
        ]}>
        {feedback.text}
      </Text>
    </View>
  );
}

function SaveButton({
  label,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: busy || disabled }}
      disabled={busy || disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.saveButton,
        pressed && styles.saveButtonPressed,
        (busy || disabled) && styles.disabled,
      ]}>
      {busy ? (
        <ActivityIndicator color="#FFFFFF" size="small" />
      ) : (
        <FontAwesome6 color="#FFFFFF" name="floppy-disk" size={12} />
      )}
      <Text style={styles.saveButtonText}>{busy ? 'Saving…' : label}</Text>
    </Pressable>
  );
}

function Gate({
  icon,
  title,
  detail,
  action,
  onAction,
  busy,
}: {
  icon: keyof typeof FontAwesome6.glyphMap;
  title: string;
  detail: string;
  action?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <View role="main" style={styles.gate}>
      <BrandMark />
      <View style={styles.gateIcon}>
        {busy ? (
          <ActivityIndicator color={palette.accentDeep} />
        ) : (
          <FontAwesome6 color={palette.accentDeep} name={icon} size={20} />
        )}
      </View>
      <Text accessibilityRole="header" style={styles.gateTitle}>
        {title}
      </Text>
      <Text style={styles.gateDetail}>{detail}</Text>
      {action && onAction && !busy ? (
        <Pressable
          accessibilityLabel={action}
          accessibilityRole="button"
          onPress={onAction}
          style={styles.gateButton}>
          <Text style={styles.gateButtonText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function BusinessSetupScreen() {
  const params = useLocalSearchParams<{ businessId?: string | string[] }>();
  const auth = useAuth();
  const businessId = (
    Array.isArray(params.businessId)
      ? (params.businessId[0] ?? '')
      : (params.businessId ?? '')
  ).trim();
  const accountId =
    auth.status === 'authenticated' && auth.account?.id ? auth.account.id : null;
  const accountScope = accountId ? `account:${accountId}` : `session:${auth.status}`;
  const accessScope =
    auth.securityStatus === 'ready' &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === 'aal2'
      ? 'aal2'
      : 'locked';

  return (
    <BusinessSetupContent
      businessId={businessId}
      expectedUserId={accountId}
      key={`${accountScope}:${accessScope}:business-setup:${businessId}`}
    />
  );
}

function BusinessSetupContent({
  businessId,
  expectedUserId,
}: BusinessSetupContentProps) {
  const auth = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= 720;
  const [configuration, setConfiguration] = useState<BusinessConfiguration | null>(null);
  const [location, setLocation] = useState<LocationEditor | null>(null);
  const [additionalLocations, setAdditionalLocations] = useState<LocationEditor[]>([]);
  const [hours, setHours] = useState<ManagedWeeklyHour[]>([]);
  const [specialHours, setSpecialHours] = useState<ManagedSpecialHour[]>([]);
  const [mobileStops, setMobileStops] = useState<ManagedMobileStop[]>([]);
  const [payments, setPayments] = useState<PaymentKind[]>([]);
  const [menuSections, setMenuSections] = useState<ManagedMenuSection[]>([]);
  const [menuPriceDrafts, setMenuPriceDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busySection, setBusySection] = useState<SectionKey | 'locating' | null>(null);
  const [feedback, setFeedback] = useState<Partial<Record<SectionKey, Feedback>>>({});
  const [needsReload, setNeedsReload] = useState(false);
  const [dirtySections, setDirtySections] = useState<
    Partial<Record<EditableSectionKey, boolean>>
  >({});
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const mutationBusy = useRef(false);
  const secureSession =
    Boolean(expectedUserId) &&
    auth.isConfigured &&
    auth.status === 'authenticated' &&
    auth.securityStatus === 'ready' &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === 'aal2';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
      mutationGeneration.current += 1;
      mutationBusy.current = false;
    };
  }, []);

  const hydrate = useCallback((next: BusinessConfiguration) => {
    setConfiguration(next);
    setLocation(locationEditor(next.location, next.business.kind));
    setAdditionalLocations(
      next.locations
        .filter((entry) => !entry.isPrimary)
        .map((entry) => locationEditor(entry, next.business.kind))
    );
    setHours(defaultHours(next.hours));
    setSpecialHours(next.specialHours);
    setMobileStops(next.mobileStops);
    setPayments(next.payments);
    setMenuSections(next.menuSections);
    setMenuPriceDrafts(priceDraftsFor(next.menuSections));
    setNeedsReload(false);
    setDirtySections({});
  }, []);

  const load = useCallback(async () => {
    if (!businessId) {
      setLoading(false);
      setLoadError('This business setup link is missing a valid business ID.');
      return;
    }
    if (!secureSession || !expectedUserId) return;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setLoadError(null);
    const result = await loadBusinessConfiguration(businessId, expectedUserId);
    if (!mounted.current || loadGeneration.current !== generation) return;
    setLoading(false);
    if (!result.ok) {
      setLoadError(result.reason);
      return;
    }
    hydrate(result.data);
  }, [
    businessId,
    expectedUserId,
    hydrate,
    secureSession,
  ]);

  useEffect(() => {
    if (secureSession) {
      const timer = setTimeout(() => {
        void load();
      }, 0);
      return () => {
        clearTimeout(timer);
        loadGeneration.current += 1;
      };
    }
    return undefined;
  }, [load, secureSession]);

  const beginMutation = useCallback(
    (section: SectionKey | 'locating') => {
      if (!secureSession || !expectedUserId || mutationBusy.current) return null;
      mutationBusy.current = true;
      const generation = mutationGeneration.current + 1;
      mutationGeneration.current = generation;
      setBusySection(section);
      return generation;
    },
    [expectedUserId, secureSession]
  );

  const finishMutation = useCallback((generation: number) => {
    if (!mounted.current || mutationGeneration.current !== generation) return false;
    mutationBusy.current = false;
    setBusySection(null);
    return true;
  }, []);

  const isCurrentMutation = useCallback(
    (generation: number) =>
      mounted.current && mutationGeneration.current === generation,
    []
  );

  const readiness = useMemo(
    () =>
      configuration
        ? configurationReadiness(configuration)
        : {
            location: false,
            hours: false,
            payments: false,
            menu: false,
            contacts: false,
            permit: false,
          },
    [configuration]
  );
  const completedCount = [
    readiness.location,
    readiness.hours,
    readiness.payments,
    readiness.menu,
  ].filter(Boolean).length;
  const allRequirementsReady =
    completedCount === 4 && readiness.contacts && readiness.permit;
  const isDraft = configuration?.business.state === 'draft';
  const canEditListing =
    isDraft || configuration?.business.state === 'published';
  const isHomeKitchen = configuration?.business.kind === 'home_kitchen';
  const isMobileBusiness =
    configuration?.business.kind === 'food_truck' ||
    configuration?.business.kind === 'pop_up';
  const savedServiceLocations = [location, ...additionalLocations].filter(
    (entry): entry is LocationEditor & { id: string } => Boolean(entry?.id)
  );
  const isBusy = mutationBusy.current || busySection !== null;
  const hasUnsavedChanges = Object.values(dirtySections).some(Boolean);

  const markDirty = (section: EditableSectionKey) => {
    setDirtySections((current) => ({ ...current, [section]: true }));
    setFeedback((current) => ({ ...current, [section]: undefined }));
  };

  const markSaved = (section: EditableSectionKey) => {
    setDirtySections((current) => ({ ...current, [section]: false }));
  };

  const patchLocation = (patch: Partial<LocationEditor>) => {
    if (isBusy || !canEditListing) return;
    setLocation((current) => (current ? { ...current, ...patch } : current));
    markDirty('location');
  };

  const returnToStudio = async () => {
    if (isBusy) return;
    if (hasUnsavedChanges) {
      const confirmed = await confirmAction({
        title: 'Discard unsaved changes?',
        message: 'Changes in sections you have not saved will be lost.',
        confirmLabel: 'Discard changes',
        destructive: true,
      });
      if (!mounted.current || !confirmed) return;
    }
    router.replace('/(tabs)/studio');
  };

  const showFeedback = (section: SectionKey, next: Feedback) => {
    setFeedback((current) => ({ ...current, [section]: next }));
    if (next.partial) setNeedsReload(true);
  };

  const applyCurrentLocation = async (additionalIndex?: number) => {
    if (mutationBusy.current || !canEditListing) return;
    const generation = beginMutation('locating');
    if (generation === null) return;
    try {
      const permission = await ExpoLocation.requestForegroundPermissionsAsync();
      if (!isCurrentMutation(generation)) return;
      if (!permission.granted) {
        showFeedback('location', {
          type: 'error',
          text: 'Location access was not granted. Enter latitude and longitude manually.',
        });
        return;
      }
      const current = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
      });
      if (!isCurrentMutation(generation)) return;
      const coordinates = {
        latitude: current.coords.latitude.toFixed(6),
        longitude: current.coords.longitude.toFixed(6),
      };
      if (additionalIndex === undefined) {
        setLocation((value) => (value ? { ...value, ...coordinates } : value));
      } else {
        setAdditionalLocations((values) =>
          values.map((value, index) =>
            index === additionalIndex ? { ...value, ...coordinates } : value
          )
        );
      }
      markDirty('location');
      showFeedback('location', {
        type: 'success',
        text: 'Current coordinates added. Review the address, then save the private pin.',
      });
    } catch {
      if (isCurrentMutation(generation)) {
        showFeedback('location', {
          type: 'error',
          text: 'Your position could not be read. Enter latitude and longitude manually.',
        });
      }
    } finally {
      finishMutation(generation);
    }
  };

  const saveLocation = async () => {
    if (!location || mutationBusy.current || !canEditListing) return;
    const generation = beginMutation('location');
    if (generation === null || !expectedUserId) return;
    setFeedback((current) => ({ ...current, location: undefined }));
    const inputs = [location, ...additionalLocations].map((entry) => ({
      ...entry,
      latitude: entry.latitude.trim() ? Number(entry.latitude) : null,
      longitude: entry.longitude.trim() ? Number(entry.longitude) : null,
    }));
    const result = await saveDraftServiceLocations(
      businessId,
      inputs,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('location', { type: 'error', text: result.reason, partial: result.partial });
      return;
    }
    const primary = result.data.find((entry) => entry.isPrimary) ?? null;
    const kind = configuration?.business.kind ?? 'food_truck';
    setLocation(locationEditor(primary, kind));
    setAdditionalLocations(
      result.data
        .filter((entry) => !entry.isPrimary)
        .map((entry) => locationEditor(entry, kind))
    );
    setConfiguration((current) =>
      current
        ? {
            ...current,
            location: primary,
            locations: result.data,
          }
        : current
    );
    markSaved('location');
    showFeedback('location', { type: 'success', text: result.message ?? 'Service pin saved.' });
  };

  const addServiceLocation = () => {
    if (isBusy || !canEditListing || additionalLocations.length >= 29) return;
    setAdditionalLocations((current) => [
      ...current,
      {
        ...emptyLocation(configuration?.business.kind ?? 'food_truck'),
        isPrimary: false,
        label: `Stop pin ${current.length + 2}`,
        shareStreetAddress: false,
        isApproximate: true,
      },
    ]);
    markDirty('location');
  };

  const patchAdditionalLocation = (
    index: number,
    patch: Partial<LocationEditor>
  ) => {
    if (isBusy || !canEditListing) return;
    setAdditionalLocations((current) =>
      current.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry
      )
    );
    markDirty('location');
  };

  const removeAdditionalLocation = async (
    index: number,
    entry: LocationEditor
  ) => {
    if (isBusy || !canEditListing) return;
    if (entry.id && mobileStops.some((stop) => stop.locationId === entry.id)) {
      showFeedback('location', {
        type: 'error',
        text: 'Reassign or remove stops using this pin and save the stops before removing it.',
      });
      return;
    }
    const confirmed = await confirmAction({
      title: 'Remove this service pin?',
      message: `${entry.label || 'This stop pin'} will be removed when you save service pins.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setAdditionalLocations((current) =>
      current.filter((_, entryIndex) => entryIndex !== index)
    );
    markDirty('location');
  };

  const applyCommonWeek = () => {
    if (isBusy || !canEditListing) return;
    setHours(
      dayNames.map((_, weekday) => {
        const isWeekend = weekday === 0 || weekday === 6;
        return {
          weekday,
          opensAt: isWeekend ? '' : '09:00',
          closesAt: isWeekend ? '' : '17:00',
          isClosed: isWeekend,
          configured: true,
        };
      })
    );
    markDirty('hours');
  };

  const patchHour = (weekday: number, patch: Partial<ManagedWeeklyHour>) => {
    if (isBusy || !canEditListing) return;
    setHours((current) =>
      current.map((hour) =>
        hour.weekday === weekday ? { ...hour, ...patch, configured: true } : hour
      )
    );
    markDirty('hours');
  };

  const saveHours = async () => {
    if (mutationBusy.current || !canEditListing) return;
    const generation = beginMutation('hours');
    if (generation === null || !expectedUserId) return;
    setFeedback((current) => ({ ...current, hours: undefined }));
    const result = await saveWeeklyHours(businessId, hours, expectedUserId);
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('hours', { type: 'error', text: result.reason, partial: result.partial });
      return;
    }
    setHours(result.data);
    setConfiguration((current) => (current ? { ...current, hours: result.data } : current));
    markSaved('hours');
    showFeedback('hours', { type: 'success', text: result.message ?? 'Weekly hours saved.' });
  };

  const addSpecialHour = () => {
    if (isBusy || !canEditListing) return;
    const usedDates = new Set(specialHours.map((entry) => entry.serviceDate));
    let dayOffset = 1;
    let serviceDate = businessDateAfter(configuration!.business.timezone, dayOffset);
    while (usedDates.has(serviceDate) && dayOffset < 730) {
      dayOffset += 1;
      serviceDate = businessDateAfter(configuration!.business.timezone, dayOffset);
    }
    setSpecialHours((current) => [
      ...current,
      createSpecialHourDraft(serviceDate),
    ]);
    markDirty('specialHours');
  };

  const patchSpecialHour = (id: string, patch: Partial<ManagedSpecialHour>) => {
    if (isBusy || !canEditListing) return;
    setSpecialHours((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    );
    markDirty('specialHours');
  };

  const removeSpecialHour = async (entry: ManagedSpecialHour) => {
    if (isBusy || !canEditListing) return;
    const confirmed = await confirmAction({
      title: 'Remove special hours?',
      message: `${entry.serviceDate || 'This date'} will return to the regular weekly schedule after you save.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setSpecialHours((current) => current.filter((candidate) => candidate.id !== entry.id));
    markDirty('specialHours');
  };

  const saveSpecialHours = async () => {
    if (mutationBusy.current || !canEditListing) return;
    const generation = beginMutation('specialHours');
    if (generation === null || !expectedUserId) return;
    setFeedback((current) => ({ ...current, specialHours: undefined }));
    const result = await saveBusinessSpecialHours(
      businessId,
      specialHours,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('specialHours', {
        type: 'error',
        text: result.reason,
        partial: result.partial,
      });
      return;
    }
    setSpecialHours(result.data);
    setConfiguration((current) =>
      current ? { ...current, specialHours: result.data } : current
    );
    markSaved('specialHours');
    showFeedback('specialHours', {
      type: 'success',
      text: result.message ?? 'Special hours saved.',
    });
  };

  const addMobileStop = () => {
    const locationId = location?.id;
    if (isBusy || !isDraft || !locationId) return;
    const serviceDate = businessDateAfter(
      configuration!.business.timezone,
      Math.min(mobileStops.length + 1, 365)
    );
    setMobileStops((current) => [
      ...current,
      createMobileStopDraft(locationId, serviceDate),
    ]);
    markDirty('stops');
  };

  const patchMobileStop = (id: string, patch: Partial<ManagedMobileStop>) => {
    if (isBusy || !isDraft) return;
    setMobileStops((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    );
    markDirty('stops');
  };

  const removeMobileStop = async (entry: ManagedMobileStop) => {
    if (isBusy || !isDraft) return;
    const confirmed = await confirmAction({
      title: 'Remove upcoming stop?',
      message: `${entry.startsOn || 'This stop'} will be removed when you save.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setMobileStops((current) => current.filter((candidate) => candidate.id !== entry.id));
    markDirty('stops');
  };

  const saveMobileStops = async () => {
    if (mutationBusy.current || !isDraft) return;
    const generation = beginMutation('stops');
    if (generation === null || !expectedUserId) return;
    setFeedback((current) => ({ ...current, stops: undefined }));
    const result = await saveDraftMobileStops(
      businessId,
      mobileStops,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('stops', {
        type: 'error',
        text: result.reason,
        partial: result.partial,
      });
      return;
    }
    setMobileStops(result.data);
    setConfiguration((current) =>
      current ? { ...current, mobileStops: result.data } : current
    );
    markSaved('stops');
    showFeedback('stops', {
      type: 'success',
      text: result.message ?? 'Upcoming stops saved.',
    });
  };

  const togglePayment = (payment: PaymentKind) => {
    if (isBusy || !canEditListing) return;
    setPayments((current) =>
      current.includes(payment)
        ? current.filter((currentPayment) => currentPayment !== payment)
        : [...current, payment]
    );
    markDirty('payments');
  };

  const savePayments = async () => {
    if (mutationBusy.current || !canEditListing) return;
    const generation = beginMutation('payments');
    if (generation === null || !expectedUserId) return;
    setFeedback((current) => ({ ...current, payments: undefined }));
    const result = await saveBusinessPayments(
      businessId,
      payments,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('payments', { type: 'error', text: result.reason, partial: result.partial });
      return;
    }
    setPayments(result.data);
    setConfiguration((current) => (current ? { ...current, payments: result.data } : current));
    markSaved('payments');
    showFeedback('payments', { type: 'success', text: result.message ?? 'Payments saved.' });
  };

  const patchSection = (sectionId: string, patch: Partial<ManagedMenuSection>) => {
    if (isBusy || !canEditListing) return;
    setMenuSections((current) =>
      current.map((section) => (section.id === sectionId ? { ...section, ...patch } : section))
    );
    markDirty('menu');
  };

  const patchItem = (
    sectionId: string,
    itemId: string,
    patch: Partial<ManagedMenuItem>
  ) => {
    if (isBusy || !canEditListing) return;
    setMenuSections((current) =>
      current.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              items: section.items.map((item) =>
                item.id === itemId ? { ...item, ...patch } : item
              ),
            }
          : section
      )
    );
    markDirty('menu');
  };

  const addSection = () => {
    if (isBusy || !canEditListing) return;
    setMenuSections((current) => [...current, createMenuSectionDraft(current.length)]);
    markDirty('menu');
  };

  const removeSection = async (section: ManagedMenuSection) => {
    if (isBusy || !canEditListing) return;
    const confirmed = await confirmAction({
      title: 'Remove menu section?',
      message: `“${section.name || 'Untitled section'}” and its items will be deleted when you save the menu.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setMenuSections((current) => current.filter((entry) => entry.id !== section.id));
    setMenuPriceDrafts((current) => {
      const next = { ...current };
      section.items.forEach((item) => delete next[item.id]);
      return next;
    });
    markDirty('menu');
  };

  const addItem = (sectionId: string) => {
    if (isBusy || !canEditListing) return;
    const item = createMenuItemDraft(
      menuSections.find((section) => section.id === sectionId)?.items.length ?? 0
    );
    setMenuSections((current) =>
      current.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              items: [...section.items, item],
            }
          : section
      )
    );
    setMenuPriceDrafts((current) => ({ ...current, [item.id]: '' }));
    markDirty('menu');
  };

  const removeItem = async (sectionId: string, item: ManagedMenuItem) => {
    if (isBusy || !canEditListing) return;
    const confirmed = await confirmAction({
      title: 'Remove menu item?',
      message: `“${item.name || 'Untitled item'}” will be deleted when you save the menu.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setMenuSections((current) =>
      current.map((section) =>
        section.id === sectionId
          ? { ...section, items: section.items.filter((entry) => entry.id !== item.id) }
          : section
      )
    );
    setMenuPriceDrafts((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    markDirty('menu');
  };

  const saveMenu = async () => {
    if (mutationBusy.current || !canEditListing) return;
    let invalidPriceItem = '';
    const menuToSave = menuSections.map((section) => ({
      ...section,
      items: section.items.map((item) => {
        const priceMinor = priceMinorFromDraft(menuPriceDrafts[item.id] ?? '');
        if (priceMinor === null && !invalidPriceItem) {
          invalidPriceItem = item.name.trim() || 'Each menu item';
        }
        return { ...item, priceMinor: priceMinor ?? Number.NaN };
      }),
    }));
    if (invalidPriceItem) {
      showFeedback('menu', {
        type: 'error',
        text: `${invalidPriceItem} needs a valid USD price from 0.00 to 1000000.00.`,
      });
      return;
    }
    const generation = beginMutation('menu');
    if (generation === null || !expectedUserId) return;
    setFeedback((current) => ({ ...current, menu: undefined }));
    const result = await saveBusinessMenu(
      businessId,
      menuToSave,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('menu', { type: 'error', text: result.reason, partial: result.partial });
      return;
    }
    setMenuSections(result.data);
    setMenuPriceDrafts(priceDraftsFor(result.data));
    setConfiguration((current) =>
      current ? { ...current, menuSections: result.data } : current
    );
    markSaved('menu');
    showFeedback('menu', { type: 'success', text: result.message ?? 'Menu saved.' });
  };

  const submit = async () => {
    if (
      mutationBusy.current ||
      !isDraft ||
      hasUnsavedChanges ||
      !allRequirementsReady
    ) {
      return;
    }
    const generation = beginMutation('submit');
    if (generation === null || !expectedUserId) return;
    const confirmed = await confirmAction({
      title: 'Submit this listing?',
      message:
        'Setup will be locked while Spottr reviews ownership, eligibility, and listing quality.',
      confirmLabel: 'Submit for review',
    });
    if (!isCurrentMutation(generation)) return;
    if (!confirmed) {
      finishMutation(generation);
      return;
    }
    setFeedback((current) => ({ ...current, submit: undefined }));
    const result = await submitBusinessConfiguration(
      businessId,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      showFeedback('submit', { type: 'error', text: result.reason, partial: result.partial });
      return;
    }
    hydrate(result.data);
    showFeedback('submit', {
      type: 'success',
      text: result.message ?? 'Submitted for verification.',
    });
  };

  if (auth.isConfigured && auth.status === 'loading') {
    return (
      <Gate
        busy
        detail="Checking your secure business access."
        icon="shield-halved"
        title="Opening setup"
      />
    );
  }

  if (auth.isConfigured && auth.status !== 'authenticated') {
    return (
      <Gate
        action="Sign in"
        detail="An authenticated, active owner or manager account is required."
        icon="user-shield"
        onAction={() => router.replace('/auth')}
        title="Business access required"
      />
    );
  }

  if (
    auth.isConfigured &&
    (auth.securityStatus !== 'ready' ||
      !auth.mfaEnrolled ||
      auth.assuranceLevel !== 'aal2')
  ) {
    return (
      <Gate
        action="Open security settings"
        busy={auth.securityStatus === 'loading'}
        detail="Connect an authenticator and verify a current code before reading or changing private business setup."
        icon="mobile-screen-button"
        onAction={() => router.replace('/security')}
        title={
          auth.securityStatus === 'loading'
            ? 'Checking workspace security'
            : 'Protect this business workspace'
        }
      />
    );
  }

  if (!auth.isConfigured) {
    return (
      <Gate
        action="Back to Studio"
        detail="Connect the production Supabase project before saving private locations, hours, payments, or menus."
        icon="link-slash"
        onAction={() => router.replace('/(tabs)/studio')}
        title="Live services are not connected"
      />
    );
  }

  if (loading) {
    return (
      <Gate
        busy
        detail="Loading private listing details and checking your role."
        icon="shield-halved"
        title="Loading business setup"
      />
    );
  }

  if (loadError || !configuration || !location) {
    return (
      <Gate
        action="Back to Studio"
        detail={loadError ?? 'This business setup is unavailable.'}
        icon="triangle-exclamation"
        onAction={() => router.replace('/(tabs)/studio')}
        title="Setup could not be opened"
      />
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={12}
      style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable
              accessibilityLabel="Back to Business Studio"
              accessibilityRole="button"
              accessibilityState={{ disabled: isBusy }}
              disabled={isBusy}
              onPress={() => void returnToStudio()}
              style={styles.backButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={13} />
            </Pressable>
            <BrandMark />
            <View style={styles.topbarSpacer} />
          </View>

          <View style={styles.intro}>
            <View style={styles.eyebrowRow}>
              <Text style={styles.eyebrow}>BUSINESS SETUP</Text>
              <View
                style={[
                  styles.stateBadge,
                  configuration.business.state === 'pending' && styles.stateBadgePending,
                ]}>
                <Text style={styles.stateBadgeText}>
                  {configuration.business.state.toLocaleUpperCase('en-US')}
                </Text>
              </View>
            </View>
            <Text accessibilityRole="header" style={styles.title}>
              {configuration.business.name}
            </Text>
            <Text style={styles.subtitle}>
              Save each required section. Nothing becomes public from this screen; an owner submits
              the completed draft for verification.
            </Text>
          </View>

          <View style={styles.progressSummary}>
            <View style={styles.progressCopy}>
              <Text style={styles.progressCount}>{completedCount} of 4 ready</Text>
              <Text style={styles.progressDetail}>Based only on saved information</Text>
            </View>
            <View
              accessibilityLabel={`${completedCount} of 4 setup sections complete`}
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: 4, now: completedCount }}
              style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${completedCount * 25}%` }]} />
            </View>
          </View>

          {needsReload ? (
            <View accessibilityRole="alert" style={styles.reloadNotice}>
              <FontAwesome6 color={palette.warning} name="rotate" size={13} />
              <View style={styles.reloadCopy}>
                <Text style={styles.reloadTitle}>Reload before editing again</Text>
                <Text style={styles.reloadText}>
                  A connection stopped during a multi-step save, so the server may contain part of
                  the change.
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Reload business setup"
                accessibilityRole="button"
                onPress={() => void load()}
                style={styles.reloadButton}>
                <Text style={styles.reloadButtonText}>Reload</Text>
              </Pressable>
            </View>
          ) : null}

          {!canEditListing ? (
            <View style={styles.lockedNotice}>
              <FontAwesome6 color={palette.warning} name="lock" size={13} />
              <Text style={styles.lockedText}>
                {configuration.business.state === 'pending'
                  ? 'This setup is locked while Spottr reviews the listing.'
                  : 'Setup editing is available only for draft listings. Use Business Studio for live operations.'}
              </Text>
            </View>
          ) : null}
          {configuration.business.state === 'published' ? (
            <View style={styles.privacyNotice}>
              <FontAwesome6 color={palette.success} name="shield-check" size={13} />
              <Text style={styles.privacyText}>
                You can propose verified changes here. Each saved section enters a protected
                revision review, while the current public listing stays unchanged.
              </Text>
            </View>
          ) : null}

          <Section
            complete={readiness.location}
            detail="Exact coordinates stay member-only while the listing is a draft."
            icon="location-dot"
            title="Primary service pin">
            {isHomeKitchen ? (
              <View style={styles.privacyNotice}>
                <FontAwesome6 color={palette.success} name="house-lock" size={14} />
                <Text style={styles.privacyText}>
                  Home-kitchen street addresses remain private. If approved, customers see only a
                  snapped approximate area and never the submitted street or ZIP.
                </Text>
              </View>
            ) : null}
            <View style={[styles.fieldGrid, wide && styles.fieldGridWide]}>
              <Field
                editable={canEditListing && !isBusy}
                label="Location label"
                onChangeText={(value) => patchLocation({ label: value })}
                placeholder="Primary service location"
                required
                style={wide && styles.halfField}
                value={location.label}
              />
              <Field
                autoCapitalize="words"
                editable={canEditListing && !isBusy}
                label="Street address"
                onChangeText={(value) => patchLocation({ addressLine: value })}
                placeholder={isHomeKitchen ? 'Stored privately' : '123 Market Street'}
                required
                style={wide && styles.halfField}
                value={location.addressLine}
              />
              <Field
                autoCapitalize="words"
                editable={canEditListing && !isBusy}
                label="City"
                onChangeText={(value) => patchLocation({ city: value })}
                placeholder="Los Angeles"
                required
                style={wide && styles.halfField}
                value={location.city}
              />
              <Field
                autoCapitalize="characters"
                editable={canEditListing && !isBusy}
                label="State or region"
                maxLength={80}
                onChangeText={(value) => patchLocation({ region: value })}
                placeholder="CA"
                required
                style={wide && styles.quarterField}
                value={location.region}
              />
              <Field
                autoCapitalize="characters"
                editable={canEditListing && !isBusy}
                label="ZIP or postal code"
                maxLength={24}
                onChangeText={(value) => patchLocation({ postalCode: value })}
                placeholder="90012"
                required
                style={wide && styles.quarterField}
                value={location.postalCode}
              />
              <Field
                autoCapitalize="none"
                editable={canEditListing && !isBusy}
                keyboardType="numbers-and-punctuation"
                label="Latitude"
                onChangeText={(value) => patchLocation({ latitude: value })}
                placeholder="34.052235"
                required
                style={wide && styles.halfField}
                value={location.latitude}
              />
              <Field
                autoCapitalize="none"
                editable={canEditListing && !isBusy}
                keyboardType="numbers-and-punctuation"
                label="Longitude"
                onChangeText={(value) => patchLocation({ longitude: value })}
                placeholder="-118.243683"
                required
                style={wide && styles.halfField}
                value={location.longitude}
              />
            </View>
            <Pressable
              accessibilityLabel="Use current location for the primary service pin"
              accessibilityRole="button"
              accessibilityState={{
                busy: busySection === 'locating',
                disabled: !canEditListing || isBusy,
              }}
              disabled={!canEditListing || isBusy}
              onPress={() => void applyCurrentLocation()}
              style={({ pressed }) => [
                styles.locationHelper,
                pressed && styles.pressed,
                (!canEditListing || isBusy) && styles.disabled,
              ]}>
              {busySection === 'locating' ? (
                <ActivityIndicator color={palette.accentDeep} size="small" />
              ) : (
                <FontAwesome6 color={palette.accentDeep} name="crosshairs" size={12} />
              )}
              <View style={styles.locationHelperCopy}>
                <Text style={styles.locationHelperTitle}>Use this device’s current location</Text>
                <Text style={styles.locationHelperDetail}>
                  Foreground access only. Review the coordinates before saving.
                </Text>
              </View>
            </Pressable>
            {!isHomeKitchen ? (
              <>
                <CheckRow
                  checked={location.shareStreetAddress}
                  disabled={!canEditListing || isBusy}
                  detail="If approved later, customers may see this address. The draft pin remains private."
                  label="Show street address after publication"
                  onPress={() =>
                    patchLocation({ shareStreetAddress: !location.shareStreetAddress })
                  }
                />
                <CheckRow
                  checked={location.isApproximate}
                  disabled={!canEditListing || isBusy}
                  detail="Useful for mobile service areas. Public discovery receives a snapped area."
                  label="Show an approximate area after publication"
                  onPress={() => patchLocation({ isApproximate: !location.isApproximate })}
                />
              </>
            ) : null}
            {isMobileBusiness ? (
              <View style={styles.additionalLocations}>
                <View style={styles.sectionTools}>
                  <View style={styles.additionalLocationCopy}>
                    <Text style={styles.controlLabel}>Reusable stop pins</Text>
                    <Text style={styles.helperText}>
                      Save each neighborhood, lot, or event location, then choose it on an upcoming
                      stop.
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Add a reusable stop pin"
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled:
                        !canEditListing || isBusy || additionalLocations.length >= 29,
                    }}
                    disabled={!canEditListing || isBusy || additionalLocations.length >= 29}
                    onPress={addServiceLocation}
                    style={[
                      styles.textButton,
                      (!canEditListing || isBusy || additionalLocations.length >= 29) &&
                        styles.disabled,
                    ]}>
                    <FontAwesome6 color={palette.accentDeep} name="plus" size={10} />
                    <Text style={styles.textButtonText}>Add stop pin</Text>
                  </Pressable>
                </View>
                {additionalLocations.map((entry, index) => (
                  <View key={entry.id ?? `new-stop-pin-${index}`} style={styles.optionalCard}>
                    <View style={styles.menuItemTop}>
                      <Text style={styles.menuItemNumber}>STOP PIN {index + 2}</Text>
                      <Pressable
                        accessibilityLabel={`Remove ${entry.label || `stop pin ${index + 2}`}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canEditListing || isBusy }}
                        disabled={!canEditListing || isBusy}
                        onPress={() => void removeAdditionalLocation(index, entry)}
                        style={styles.iconButton}>
                        <FontAwesome6 color={palette.accentDeep} name="xmark" size={12} />
                      </Pressable>
                    </View>
                    <View style={[styles.fieldGrid, wide && styles.fieldGridWide]}>
                      <Field
                        editable={canEditListing && !isBusy}
                        label="Location label"
                        maxLength={120}
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { label: value })
                        }
                        placeholder="Friday arts district stop"
                        required
                        style={wide && styles.halfField}
                        value={entry.label}
                      />
                      <Field
                        autoCapitalize="words"
                        editable={canEditListing && !isBusy}
                        label="Street address"
                        maxLength={300}
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { addressLine: value })
                        }
                        placeholder="500 Event Way"
                        required
                        style={wide && styles.halfField}
                        value={entry.addressLine}
                      />
                      <Field
                        autoCapitalize="words"
                        editable={canEditListing && !isBusy}
                        label="City"
                        maxLength={120}
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { city: value })
                        }
                        placeholder="Los Angeles"
                        required
                        style={wide && styles.halfField}
                        value={entry.city}
                      />
                      <Field
                        autoCapitalize="characters"
                        editable={canEditListing && !isBusy}
                        label="State or region"
                        maxLength={80}
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { region: value })
                        }
                        placeholder="CA"
                        required
                        style={wide && styles.quarterField}
                        value={entry.region}
                      />
                      <Field
                        autoCapitalize="characters"
                        editable={canEditListing && !isBusy}
                        label="ZIP or postal code"
                        maxLength={24}
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { postalCode: value })
                        }
                        placeholder="90012"
                        required
                        style={wide && styles.quarterField}
                        value={entry.postalCode}
                      />
                      <Field
                        autoCapitalize="none"
                        editable={canEditListing && !isBusy}
                        keyboardType="numbers-and-punctuation"
                        label="Latitude"
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { latitude: value })
                        }
                        placeholder="34.052235"
                        required
                        style={wide && styles.halfField}
                        value={entry.latitude}
                      />
                      <Field
                        autoCapitalize="none"
                        editable={canEditListing && !isBusy}
                        keyboardType="numbers-and-punctuation"
                        label="Longitude"
                        onChangeText={(value) =>
                          patchAdditionalLocation(index, { longitude: value })
                        }
                        placeholder="-118.243683"
                        required
                        style={wide && styles.halfField}
                        value={entry.longitude}
                      />
                    </View>
                    <Pressable
                      accessibilityLabel={`Use current location for ${entry.label || `stop pin ${index + 2}`}`}
                      accessibilityRole="button"
                      accessibilityState={{
                        busy: busySection === 'locating',
                        disabled: !canEditListing || isBusy,
                      }}
                      disabled={!canEditListing || isBusy}
                      onPress={() => void applyCurrentLocation(index)}
                      style={({ pressed }) => [
                        styles.locationHelper,
                        pressed && styles.pressed,
                        (!canEditListing || isBusy) && styles.disabled,
                      ]}>
                      <FontAwesome6 color={palette.accentDeep} name="crosshairs" size={12} />
                      <View style={styles.locationHelperCopy}>
                        <Text style={styles.locationHelperTitle}>Use current location</Text>
                        <Text style={styles.locationHelperDetail}>
                          Replace only this stop pin’s coordinates.
                        </Text>
                      </View>
                    </Pressable>
                    <CheckRow
                      checked={entry.shareStreetAddress}
                      disabled={!canEditListing || isBusy}
                      label="Show street address after publication"
                      onPress={() =>
                        patchAdditionalLocation(index, {
                          shareStreetAddress: !entry.shareStreetAddress,
                        })
                      }
                    />
                    <CheckRow
                      checked={entry.isApproximate}
                      disabled={!canEditListing || isBusy}
                      label="Show an approximate public area"
                      onPress={() =>
                        patchAdditionalLocation(index, {
                          isApproximate: !entry.isApproximate,
                        })
                      }
                    />
                  </View>
                ))}
              </View>
            ) : null}
            <InlineFeedback feedback={feedback.location} />
            <SaveButton
              busy={busySection === 'location'}
              disabled={!canEditListing || needsReload || (isBusy && busySection !== 'location')}
              label={
                additionalLocations.length
                  ? 'Save all service pins'
                  : 'Save service pin'
              }
              onPress={() => void saveLocation()}
            />
          </Section>

          <Section
            complete={readiness.hours}
            detail="Confirm every day, including days when you are closed."
            icon="clock"
            title="Weekly hours">
            <View style={styles.sectionTools}>
              <Text style={styles.sectionToolNote}>Times use your business time zone.</Text>
              <Pressable
                accessibilityLabel="Apply Monday through Friday, 9 AM to 5 PM hours"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canEditListing || isBusy }}
                disabled={!canEditListing || isBusy}
                onPress={applyCommonWeek}
                style={[styles.textButton, (!canEditListing || isBusy) && styles.disabled]}>
                <FontAwesome6 color={palette.accentDeep} name="wand-magic-sparkles" size={10} />
                <Text style={styles.textButtonText}>Mon–Fri, 9–5</Text>
              </Pressable>
            </View>
            <View style={styles.hoursList}>
              {hours.map((hour) => (
                <View key={hour.weekday} style={styles.hourRow}>
                  <View style={styles.dayCopy}>
                    <Text style={styles.dayName}>{dayNames[hour.weekday]}</Text>
                    <Text style={[styles.dayState, !hour.configured && styles.dayStateRequired]}>
                      {hour.configured ? (hour.isClosed ? 'Closed' : 'Open') : 'Confirm'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`${dayNames[hour.weekday]} is closed`}
                    accessibilityRole="checkbox"
                    aria-checked={hour.isClosed}
                    accessibilityState={{ checked: hour.isClosed, disabled: !canEditListing || isBusy }}
                    disabled={!canEditListing || isBusy}
                    onPress={() =>
                      patchHour(hour.weekday, {
                        isClosed: !hour.isClosed,
                        opensAt: hour.isClosed ? '09:00' : '',
                        closesAt: hour.isClosed ? '17:00' : '',
                      })
                    }
                    style={[styles.closedToggle, hour.isClosed && styles.closedToggleActive]}>
                    <View style={[styles.miniCheck, hour.isClosed && styles.miniCheckActive]}>
                      {hour.isClosed ? <FontAwesome6 color="#FFFFFF" name="check" size={8} /> : null}
                    </View>
                    <Text
                      style={[
                        styles.closedToggleText,
                        hour.isClosed && styles.closedToggleTextActive,
                      ]}>
                      Closed
                    </Text>
                  </Pressable>
                  <View style={styles.timeFields}>
                    <TextInput
                      accessibilityLabel={`${dayNames[hour.weekday]} opening time`}
                      accessibilityState={{
                        disabled: !canEditListing || isBusy || hour.isClosed,
                      }}
                      autoCapitalize="none"
                      editable={canEditListing && !isBusy && !hour.isClosed}
                      maxLength={5}
                      onChangeText={(value) => patchHour(hour.weekday, { opensAt: value })}
                      placeholder="09:00"
                      placeholderTextColor={palette.mutedLight}
                      style={[styles.timeInput, hour.isClosed && styles.inputDisabled]}
                      value={hour.opensAt}
                    />
                    <Text style={styles.timeDash}>–</Text>
                    <TextInput
                      accessibilityLabel={`${dayNames[hour.weekday]} closing time`}
                      accessibilityState={{
                        disabled: !canEditListing || isBusy || hour.isClosed,
                      }}
                      autoCapitalize="none"
                      editable={canEditListing && !isBusy && !hour.isClosed}
                      maxLength={5}
                      onChangeText={(value) => patchHour(hour.weekday, { closesAt: value })}
                      placeholder="17:00"
                      placeholderTextColor={palette.mutedLight}
                      style={[styles.timeInput, hour.isClosed && styles.inputDisabled]}
                      value={hour.closesAt}
                    />
                  </View>
                </View>
              ))}
            </View>
            <Text style={styles.helperText}>
              Use 24-hour time. A closing time earlier than opening means service ends the next day.
            </Text>
            <InlineFeedback feedback={feedback.hours} />
            <SaveButton
              busy={busySection === 'hours'}
              disabled={!canEditListing || needsReload || (isBusy && busySection !== 'hours')}
              label="Save weekly hours"
              onPress={() => void saveHours()}
            />
          </Section>

          <Section
            complete={configuration.specialHours.length > 0}
            detail="Override the regular schedule for holidays, events, or one-off closures."
            icon="calendar-day"
            required={false}
            title="Special hours">
            <View style={styles.sectionTools}>
              <Text style={styles.sectionToolNote}>
                Dates and times use {configuration.business.timezone}.
              </Text>
              <Pressable
                accessibilityLabel="Add a special-hours date"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canEditListing || isBusy }}
                disabled={!canEditListing || isBusy}
                onPress={addSpecialHour}
                style={[styles.textButton, (!canEditListing || isBusy) && styles.disabled]}>
                <FontAwesome6 color={palette.accentDeep} name="plus" size={10} />
                <Text style={styles.textButtonText}>Add date</Text>
              </Pressable>
            </View>
            {!specialHours.length ? (
              <Text style={styles.helperText}>
                No overrides added. Your seven-day schedule applies every week.
              </Text>
            ) : (
              <View style={styles.optionalList}>
                {specialHours.map((entry) => (
                  <View key={entry.id} style={styles.optionalCard}>
                    <View style={styles.menuItemTop}>
                      <Text style={styles.menuItemNumber}>SCHEDULE OVERRIDE</Text>
                      <Pressable
                        accessibilityLabel={`Remove special hours for ${entry.serviceDate || 'this date'}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canEditListing || isBusy }}
                        disabled={!canEditListing || isBusy}
                        onPress={() => void removeSpecialHour(entry)}
                        style={styles.iconButton}>
                        <FontAwesome6 color={palette.accentDeep} name="xmark" size={12} />
                      </Pressable>
                    </View>
                    <Field
                      autoCapitalize="none"
                      detail="YYYY-MM-DD"
                      editable={canEditListing && !isBusy}
                      label="Service date"
                      maxLength={10}
                      onChangeText={(value) =>
                        patchSpecialHour(entry.id, { serviceDate: value })
                      }
                      placeholder="2026-08-15"
                      required
                      value={entry.serviceDate}
                    />
                    <CheckRow
                      checked={entry.isClosed}
                      disabled={!canEditListing || isBusy}
                      label="Closed all day"
                      onPress={() =>
                        patchSpecialHour(entry.id, {
                          isClosed: !entry.isClosed,
                          opensAt: entry.isClosed ? '09:00' : '',
                          closesAt: entry.isClosed ? '17:00' : '',
                        })
                      }
                    />
                    {!entry.isClosed ? (
                      <View style={[styles.fieldGrid, wide && styles.fieldGridWide]}>
                        <Field
                          autoCapitalize="none"
                          editable={canEditListing && !isBusy}
                          label="Opens"
                          maxLength={5}
                          onChangeText={(value) =>
                            patchSpecialHour(entry.id, { opensAt: value })
                          }
                          placeholder="09:00"
                          required
                          style={wide && styles.halfField}
                          value={entry.opensAt}
                        />
                        <Field
                          autoCapitalize="none"
                          editable={canEditListing && !isBusy}
                          label="Closes"
                          maxLength={5}
                          onChangeText={(value) =>
                            patchSpecialHour(entry.id, { closesAt: value })
                          }
                          placeholder="17:00"
                          required
                          style={wide && styles.halfField}
                          value={entry.closesAt}
                        />
                      </View>
                    ) : null}
                    <Field
                      editable={canEditListing && !isBusy}
                      label="Customer note"
                      maxLength={240}
                      onChangeText={(value) => patchSpecialHour(entry.id, { note: value })}
                      placeholder="Optional short reason or event note"
                      value={entry.note}
                    />
                  </View>
                ))}
              </View>
            )}
            <Text style={styles.helperText}>
              A closing time earlier than opening is treated as an overnight service window.
            </Text>
            <InlineFeedback feedback={feedback.specialHours} />
            <SaveButton
              busy={busySection === 'specialHours'}
              disabled={
                !canEditListing || needsReload || (isBusy && busySection !== 'specialHours')
              }
              label="Save special hours"
              onPress={() => void saveSpecialHours()}
            />
          </Section>

          {isMobileBusiness && isDraft ? (
            <Section
              complete={configuration.mobileStops.length > 0}
              detail="Add dated stops for review so customers can discover where you plan to serve."
              icon="route"
              required={false}
              title="Upcoming stops">
              <View style={styles.privacyNotice}>
                <FontAwesome6 color={palette.success} name="location-dot" size={14} />
                <Text style={styles.privacyText}>
                  Choose a saved service pin for each draft stop. Stops remain private until
                  listing review. Times use {configuration.business.timezone}.
                </Text>
              </View>
              <View style={styles.sectionTools}>
                <Text style={styles.sectionToolNote}>
                  Stops may last up to seven days and cannot overlap.
                </Text>
                <Pressable
                  accessibilityLabel="Add an upcoming mobile stop"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canEditListing || isBusy || !location.id }}
                  disabled={!canEditListing || isBusy || !location.id}
                  onPress={addMobileStop}
                  style={[
                    styles.textButton,
                    (!canEditListing || isBusy || !location.id) && styles.disabled,
                  ]}>
                  <FontAwesome6 color={palette.accentDeep} name="plus" size={10} />
                  <Text style={styles.textButtonText}>Add stop</Text>
                </Pressable>
              </View>
              {!location.id ? (
                <Text style={styles.helperText}>
                  Save the primary service pin before adding an upcoming stop.
                </Text>
              ) : null}
              {!mobileStops.length ? (
                <Text style={styles.helperText}>No upcoming draft stops added.</Text>
              ) : (
                <View style={styles.optionalList}>
                  {mobileStops.map((entry, index) => (
                    <View key={entry.id} style={styles.optionalCard}>
                      <View style={styles.menuItemTop}>
                        <Text style={styles.menuItemNumber}>STOP {index + 1}</Text>
                        <Pressable
                          accessibilityLabel={`Remove upcoming stop ${index + 1}`}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: !canEditListing || isBusy }}
                          disabled={!canEditListing || isBusy}
                          onPress={() => void removeMobileStop(entry)}
                          style={styles.iconButton}>
                          <FontAwesome6 color={palette.accentDeep} name="xmark" size={12} />
                        </Pressable>
                      </View>
                      <View
                        accessibilityLabel={`Location for stop ${index + 1}`}
                        accessibilityRole="radiogroup"
                        style={styles.locationChoices}>
                        <Text style={styles.controlLabel}>Service pin</Text>
                        <View style={styles.locationChoiceWrap}>
                          {savedServiceLocations.map((savedLocation) => {
                            const selected = entry.locationId === savedLocation.id;
                            return (
                              <Pressable
                                accessibilityLabel={`Use ${savedLocation.label} in ${savedLocation.city} for stop ${index + 1}`}
                                accessibilityRole="radio"
                                aria-checked={selected}
                                accessibilityState={{
                                  checked: selected,
                                  disabled: !canEditListing || isBusy,
                                }}
                                disabled={!canEditListing || isBusy}
                                key={savedLocation.id}
                                onPress={() =>
                                  patchMobileStop(entry.id, {
                                    locationId: savedLocation.id,
                                  })
                                }
                                style={[
                                  styles.locationChoice,
                                  selected && styles.locationChoiceSelected,
                                ]}>
                                <FontAwesome6
                                  color={selected ? '#FFFFFF' : palette.accentDeep}
                                  name="location-dot"
                                  size={10}
                                />
                                <Text
                                  numberOfLines={1}
                                  style={[
                                    styles.locationChoiceText,
                                    selected && styles.locationChoiceTextSelected,
                                  ]}>
                                  {savedLocation.label} · {savedLocation.city}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                      <Text style={styles.controlLabel}>Starts</Text>
                      <View style={[styles.fieldGrid, wide && styles.fieldGridWide]}>
                        <Field
                          autoCapitalize="none"
                          detail="YYYY-MM-DD"
                          editable={canEditListing && !isBusy}
                          label="Start date"
                          maxLength={10}
                          onChangeText={(value) =>
                            patchMobileStop(entry.id, { startsOn: value })
                          }
                          placeholder="2026-08-15"
                          required
                          style={wide && styles.halfField}
                          value={entry.startsOn}
                        />
                        <Field
                          autoCapitalize="none"
                          detail="24-hour"
                          editable={canEditListing && !isBusy}
                          label="Start time"
                          maxLength={5}
                          onChangeText={(value) =>
                            patchMobileStop(entry.id, { startsAt: value })
                          }
                          placeholder="11:00"
                          required
                          style={wide && styles.halfField}
                          value={entry.startsAt}
                        />
                      </View>
                      <Text style={styles.controlLabel}>Ends</Text>
                      <View style={[styles.fieldGrid, wide && styles.fieldGridWide]}>
                        <Field
                          autoCapitalize="none"
                          detail="YYYY-MM-DD"
                          editable={canEditListing && !isBusy}
                          label="End date"
                          maxLength={10}
                          onChangeText={(value) =>
                            patchMobileStop(entry.id, { endsOn: value })
                          }
                          placeholder="2026-08-15"
                          required
                          style={wide && styles.halfField}
                          value={entry.endsOn}
                        />
                        <Field
                          autoCapitalize="none"
                          detail="24-hour"
                          editable={canEditListing && !isBusy}
                          label="End time"
                          maxLength={5}
                          onChangeText={(value) =>
                            patchMobileStop(entry.id, { endsAt: value })
                          }
                          placeholder="14:00"
                          required
                          style={wide && styles.halfField}
                          value={entry.endsAt}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              )}
              <InlineFeedback feedback={feedback.stops} />
              <SaveButton
                busy={busySection === 'stops'}
                disabled={
                  !canEditListing ||
                  needsReload ||
                  (mobileStops.length > 0 && !location.id) ||
                  (isBusy && busySection !== 'stops')
                }
                label="Save upcoming stops"
                onPress={() => void saveMobileStops()}
              />
            </Section>
          ) : null}

          <Section
            complete={readiness.payments}
            detail="Customers should know how they can pay before making the trip."
            icon="credit-card"
            title="Accepted payments">
            <View accessibilityRole="list" style={styles.paymentList}>
              {paymentOptions.map((payment) => {
                const selected = payments.includes(payment.id);
                return (
                  <Pressable
                    accessibilityLabel={`Accept ${payment.label}`}
                    accessibilityRole="checkbox"
                    aria-checked={selected}
                    accessibilityState={{ checked: selected, disabled: !canEditListing || isBusy }}
                    disabled={!canEditListing || isBusy}
                    key={payment.id}
                    onPress={() => togglePayment(payment.id)}
                    style={({ pressed }) => [
                      styles.paymentChip,
                      selected && styles.paymentChipSelected,
                      pressed && styles.pressed,
                    ]}>
                    <View style={[styles.miniCheck, selected && styles.miniCheckActive]}>
                      {selected ? <FontAwesome6 color="#FFFFFF" name="check" size={8} /> : null}
                    </View>
                    <Text
                      style={[
                        styles.paymentChipText,
                        selected && styles.paymentChipTextSelected,
                      ]}>
                      {payment.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <InlineFeedback feedback={feedback.payments} />
            <SaveButton
              busy={busySection === 'payments'}
              disabled={!canEditListing || needsReload || (isBusy && busySection !== 'payments')}
              label="Save payment methods"
              onPress={() => void savePayments()}
            />
          </Section>

          <Section
            complete={readiness.menu}
            detail="Publish at least one section with one priced item."
            icon="utensils"
            title="Menu">
            {!menuSections.length ? (
              <View style={styles.emptyMenu}>
                <View style={styles.emptyMenuIcon}>
                  <FontAwesome6 color={palette.accentDeep} name="receipt" size={17} />
                </View>
                <View style={styles.emptyMenuCopy}>
                  <Text style={styles.emptyMenuTitle}>Start with one section</Text>
                  <Text style={styles.emptyMenuDetail}>
                    Add a section such as Mains, Tacos, Drinks, or Pastries.
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Add a menu section"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canEditListing || isBusy }}
                  disabled={!canEditListing || isBusy}
                  onPress={addSection}
                  style={[styles.outlineButton, (!canEditListing || isBusy) && styles.disabled]}>
                  <FontAwesome6 color={palette.ink} name="plus" size={10} />
                  <Text style={styles.outlineButtonText}>Add section</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.menuList}>
                {menuSections.map((section, sectionIndex) => (
                  <View key={section.id} style={styles.menuSection}>
                    <View style={styles.menuSectionTop}>
                      <Text style={styles.menuSectionNumber}>
                        SECTION {String(sectionIndex + 1).padStart(2, '0')}
                      </Text>
                      <Pressable
                        accessibilityLabel={`Remove ${section.name || 'menu section'}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canEditListing || isBusy }}
                        disabled={!canEditListing || isBusy}
                        onPress={() => void removeSection(section)}
                        style={styles.removeButton}>
                        <FontAwesome6 color={palette.accentDeep} name="trash-can" size={11} />
                        <Text style={styles.removeButtonText}>Remove</Text>
                      </Pressable>
                    </View>
                    <Field
                      editable={canEditListing && !isBusy}
                      label="Section name"
                      maxLength={80}
                      onChangeText={(value) => patchSection(section.id, { name: value })}
                      placeholder="Mains"
                      required
                      value={section.name}
                    />
                    <CheckRow
                      checked={section.isPublished}
                      disabled={!canEditListing || isBusy}
                      detail="Only published sections can appear after listing approval."
                      label="Publish this section"
                      onPress={() =>
                        patchSection(section.id, { isPublished: !section.isPublished })
                      }
                    />
                    <View style={styles.itemsHeader}>
                      <Text style={styles.itemsTitle}>
                        {section.items.length} {section.items.length === 1 ? 'item' : 'items'}
                      </Text>
                      <Pressable
                        accessibilityLabel={`Add an item to ${section.name || `section ${sectionIndex + 1}`}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canEditListing || isBusy }}
                        disabled={!canEditListing || isBusy}
                        onPress={() => addItem(section.id)}
                        style={[
                          styles.smallOutlineButton,
                          (!canEditListing || isBusy) && styles.disabled,
                        ]}>
                        <FontAwesome6 color={palette.ink} name="plus" size={9} />
                        <Text style={styles.smallOutlineButtonText}>Add item</Text>
                      </Pressable>
                    </View>
                    {section.items.map((item, itemIndex) => (
                      <View key={item.id} style={styles.menuItem}>
                        <View style={styles.menuItemTop}>
                          <Text style={styles.menuItemNumber}>ITEM {itemIndex + 1}</Text>
                          <Pressable
                            accessibilityLabel={`Remove ${item.name || 'menu item'}`}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !canEditListing || isBusy }}
                            disabled={!canEditListing || isBusy}
                            onPress={() => void removeItem(section.id, item)}
                            style={styles.iconButton}>
                            <FontAwesome6 color={palette.accentDeep} name="xmark" size={12} />
                          </Pressable>
                        </View>
                        <View style={[styles.fieldGrid, wide && styles.fieldGridWide]}>
                          <Field
                            editable={canEditListing && !isBusy}
                            label="Item name"
                            maxLength={120}
                            onChangeText={(value) =>
                              patchItem(section.id, item.id, { name: value })
                            }
                            placeholder="Birria tacos"
                            required
                            style={wide && styles.itemNameField}
                            value={item.name}
                          />
                          <Field
                            autoCapitalize="none"
                            detail="USD"
                            editable={canEditListing && !isBusy}
                            keyboardType="decimal-pad"
                            label="Price"
                            onChangeText={(value) => {
                              if (isBusy || !canEditListing) return;
                              setMenuPriceDrafts((current) => ({
                                ...current,
                                [item.id]: value.replace(/[^0-9.]/g, ''),
                              }));
                              markDirty('menu');
                            }}
                            maxLength={10}
                            placeholder="12.00"
                            required
                            style={wide && styles.itemPriceField}
                            value={menuPriceDrafts[item.id] ?? ''}
                          />
                        </View>
                        <Field
                          editable={canEditListing && !isBusy}
                          label="Short description"
                          maxLength={1000}
                          multiline
                          onChangeText={(value) =>
                            patchItem(section.id, item.id, { description: value })
                          }
                          placeholder="What comes with this item?"
                          value={item.description}
                        />
                        <View style={styles.itemControls}>
                          <CheckRow
                            checked={item.isPublished}
                            disabled={!canEditListing || isBusy}
                            label="Published"
                            onPress={() =>
                              patchItem(section.id, item.id, {
                                isPublished: !item.isPublished,
                              })
                            }
                          />
                          <View style={styles.availabilityControl}>
                            <Text style={styles.controlLabel}>Availability</Text>
                            <View style={styles.segmented}>
                              {(
                                [
                                  ['available', 'Available'],
                                  ['sold_out', 'Sold out'],
                                  ['hidden', 'Hidden'],
                                ] as const
                              ).map(([value, label]) => (
                                <Pressable
                                  accessibilityLabel={`${label} availability for ${item.name || `item ${itemIndex + 1}`}`}
                                  accessibilityRole="radio"
                                  aria-checked={item.availability === value}
                                  accessibilityState={{
                                    checked: item.availability === value,
                                    disabled: !canEditListing || isBusy,
                                  }}
                                  disabled={!canEditListing || isBusy}
                                  key={value}
                                  onPress={() =>
                                    patchItem(section.id, item.id, {
                                      availability: value,
                                    })
                                  }
                                  style={[
                                    styles.segment,
                                    item.availability === value && styles.segmentActive,
                                  ]}>
                                  <Text
                                    style={[
                                      styles.segmentText,
                                      item.availability === value && styles.segmentTextActive,
                                    ]}>
                                    {label}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>
                          </View>
                        </View>
                      </View>
                    ))}
                  </View>
                ))}
                <Pressable
                  accessibilityLabel="Add another menu section"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canEditListing || isBusy }}
                  disabled={!canEditListing || isBusy}
                  onPress={addSection}
                  style={[
                    styles.addSectionButton,
                    (!canEditListing || isBusy) && styles.disabled,
                  ]}>
                  <FontAwesome6 color={palette.ink} name="plus" size={11} />
                  <Text style={styles.addSectionButtonText}>Add another section</Text>
                </Pressable>
              </View>
            )}
            <InlineFeedback feedback={feedback.menu} />
            <SaveButton
              busy={busySection === 'menu'}
              disabled={!canEditListing || needsReload || (isBusy && busySection !== 'menu')}
              label="Save menu"
              onPress={() => void saveMenu()}
            />
          </Section>

          <View style={styles.submitSection}>
            <View style={styles.submitIcon}>
              <FontAwesome6 color={palette.accentDeep} name="circle-check" size={18} solid />
            </View>
            <View style={styles.submitCopy}>
              <Text accessibilityRole="header" style={styles.submitTitle}>
                Submit for verification
              </Text>
              <Text style={styles.submitDetail}>
                Spottr checks ownership, contact details, location privacy, and listing quality
                before publication. Submission does not guarantee approval.
              </Text>
            </View>
            <View style={styles.checklist}>
              {[
                ['Private service pin', readiness.location],
                ['Seven-day hours', readiness.hours],
                ['Accepted payment', readiness.payments],
                ['Published menu item', readiness.menu],
                ['Business email and phone', readiness.contacts],
                ...(isHomeKitchen
                  ? ([['Home-kitchen permit submitted', readiness.permit]] as [string, boolean][])
                  : []),
              ].map(([label, ready]) => (
                <View key={String(label)} style={styles.checklistRow}>
                  <FontAwesome6
                    color={ready ? palette.success : palette.mutedLight}
                    name={ready ? 'circle-check' : 'circle'}
                    size={12}
                  />
                  <Text style={[styles.checklistText, ready && styles.checklistTextReady]}>
                    {label}
                  </Text>
                </View>
              ))}
            </View>
            {configuration.business.role === 'manager' ? (
              <View style={styles.ownerNotice}>
                <FontAwesome6 color={palette.warning} name="key" size={12} />
                <Text style={styles.ownerNoticeText}>
                  Managers can configure the draft. An owner must submit it for verification.
                </Text>
              </View>
            ) : null}
            {hasUnsavedChanges ? (
              <View style={styles.ownerNotice}>
                <FontAwesome6 color={palette.warning} name="floppy-disk" size={12} />
                <Text style={styles.ownerNoticeText}>
                  Save or discard every edited section before submitting.
                </Text>
              </View>
            ) : null}
            <InlineFeedback feedback={feedback.submit} />
            {!isDraft ? (
              <Pressable
                accessibilityLabel="Return to Business Studio"
                accessibilityRole="button"
                onPress={() => router.replace('/(tabs)/studio')}
                style={styles.submitButton}>
                <Text style={styles.submitButtonText}>Return to Business Studio</Text>
                <FontAwesome6 color="#FFFFFF" name="arrow-right" size={11} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel="Submit business for verification"
                accessibilityRole="button"
                accessibilityState={{
                  busy: busySection === 'submit',
                  disabled:
                    !allRequirementsReady ||
                    configuration.business.role !== 'owner' ||
                    !canEditListing ||
                    needsReload ||
                    hasUnsavedChanges ||
                    busySection === 'submit',
                }}
                disabled={
                  !allRequirementsReady ||
                  configuration.business.role !== 'owner' ||
                  !canEditListing ||
                  needsReload ||
                  hasUnsavedChanges ||
                  busySection === 'submit'
                }
                onPress={() => void submit()}
                style={({ pressed }) => [
                  styles.submitButton,
                  pressed && styles.submitButtonPressed,
                  (!allRequirementsReady ||
                    configuration.business.role !== 'owner' ||
                    !canEditListing ||
                    needsReload ||
                    hasUnsavedChanges ||
                    busySection === 'submit') &&
                    styles.disabled,
                ]}>
                {busySection === 'submit' ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <FontAwesome6 color="#FFFFFF" name="shield-check" size={12} />
                )}
                <Text style={styles.submitButtonText}>
                  {busySection === 'submit' ? 'Submitting…' : 'Submit completed draft'}
                </Text>
              </Pressable>
            )}
          </View>
        </PageShell>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: 80,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  topbarSpacer: {
    width: 44,
  },
  intro: {
    gap: spacing.sm,
    marginTop: spacing.xxxl,
  },
  eyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1.2,
  },
  stateBadge: {
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  stateBadgePending: {
    backgroundColor: palette.warningSoft,
    borderColor: palette.warningSoft,
  },
  stateBadgeText: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 0.7,
  },
  title: {
    color: palette.ink,
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -1.5,
    lineHeight: 42,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 650,
  },
  progressSummary: {
    backgroundColor: palette.dark,
    borderRadius: radii.lg,
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.lg,
  },
  progressCopy: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  progressCount: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  progressDetail: {
    color: palette.darkMuted,
    fontSize: 11,
  },
  progressTrack: {
    backgroundColor: '#38504D',
    borderRadius: radii.pill,
    height: 6,
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: palette.sun,
    borderRadius: radii.pill,
    height: 6,
  },
  reloadNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  reloadCopy: {
    flex: 1,
    gap: 3,
  },
  reloadTitle: {
    color: palette.warning,
    fontSize: 12,
    fontWeight: '900',
  },
  reloadText: {
    color: palette.warning,
    fontSize: 11,
    lineHeight: 16,
  },
  reloadButton: {
    alignItems: 'center',
    borderColor: palette.warning,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  reloadButtonText: {
    color: palette.warning,
    fontSize: 11,
    fontWeight: '900',
  },
  lockedNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  lockedText: {
    color: palette.warning,
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
  },
  section: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    marginTop: spacing.lg,
    overflow: 'hidden',
  },
  sectionHeader: {
    alignItems: 'flex-start',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  sectionIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 13,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  sectionIconComplete: {
    backgroundColor: palette.successSoft,
  },
  sectionHeading: {
    flex: 1,
    gap: 4,
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: -0.25,
  },
  sectionDetail: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  sectionState: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 0.6,
    paddingTop: 3,
  },
  sectionStateComplete: {
    color: palette.success,
  },
  sectionBody: {
    gap: spacing.lg,
    padding: spacing.lg,
  },
  fieldGrid: {
    gap: spacing.md,
  },
  fieldGridWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  field: {
    gap: 7,
    minWidth: 0,
  },
  halfField: {
    flexBasis: '47%',
    flexGrow: 1,
  },
  quarterField: {
    flexBasis: '21%',
    flexGrow: 1,
  },
  fieldLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  fieldLabel: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  fieldDetail: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 11,
  },
  required: {
    color: palette.accentDeep,
  },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 14,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  multilineInput: {
    minHeight: 78,
    paddingTop: 13,
    textAlignVertical: 'top',
  },
  inputDisabled: {
    backgroundColor: palette.bg,
    color: palette.mutedLight,
  },
  privacyNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  privacyText: {
    color: palette.success,
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
  },
  checkRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: 5,
  },
  checkbox: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 6,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    marginTop: 1,
    width: 22,
  },
  checkboxChecked: {
    backgroundColor: palette.success,
    borderColor: palette.success,
  },
  checkCopy: {
    flex: 1,
    gap: 3,
  },
  checkLabel: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 16,
  },
  checkDetail: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  locationHelper: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    padding: spacing.md,
  },
  locationHelperCopy: {
    flexShrink: 1,
    gap: 2,
  },
  locationHelperTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  locationHelperDetail: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  feedback: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  feedbackSuccess: {
    backgroundColor: palette.successSoft,
  },
  feedbackText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 17,
  },
  feedbackTextSuccess: {
    color: palette.success,
  },
  saveButton: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 46,
    minWidth: 154,
    paddingHorizontal: 17,
  },
  saveButtonPressed: {
    backgroundColor: '#7E1E13',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  sectionTools: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  sectionToolNote: {
    color: palette.muted,
    fontSize: 11,
  },
  textButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 4,
  },
  textButtonText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  hoursList: {
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  hourRow: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    minHeight: 70,
    padding: spacing.md,
  },
  dayCopy: {
    flex: 1,
    minWidth: 86,
  },
  dayName: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  dayState: {
    color: palette.muted,
    fontSize: 11,
    marginTop: 3,
  },
  dayStateRequired: {
    color: palette.accentDeep,
    fontWeight: '800',
  },
  closedToggle: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 10,
  },
  closedToggleActive: {
    backgroundColor: palette.bg,
  },
  miniCheck: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 4,
    borderWidth: 1,
    height: 15,
    justifyContent: 'center',
    width: 15,
  },
  miniCheckActive: {
    backgroundColor: palette.success,
    borderColor: palette.success,
  },
  closedToggleText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  closedToggleTextActive: {
    color: palette.ink,
  },
  timeFields: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  timeInput: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: palette.ink,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    height: 44,
    paddingHorizontal: 10,
    width: 72,
  },
  timeDash: {
    color: palette.muted,
    fontSize: 11,
  },
  helperText: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  optionalList: {
    gap: spacing.md,
  },
  additionalLocations: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    gap: spacing.md,
    paddingTop: spacing.lg,
  },
  additionalLocationCopy: {
    flex: 1,
    gap: 4,
    minWidth: 190,
  },
  optionalCard: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  locationChoices: {
    gap: spacing.sm,
  },
  locationChoiceWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  locationChoice: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    maxWidth: '100%',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  locationChoiceSelected: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  locationChoiceText: {
    color: palette.ink,
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '800',
  },
  locationChoiceTextSelected: {
    color: '#FFFFFF',
  },
  paymentList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  paymentChip: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  paymentChipSelected: {
    backgroundColor: palette.successSoft,
    borderColor: palette.successSoft,
  },
  paymentChipText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  paymentChipTextSelected: {
    color: palette.success,
  },
  emptyMenu: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    padding: spacing.lg,
  },
  emptyMenuIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 14,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  emptyMenuCopy: {
    flex: 1,
    gap: 3,
    minWidth: 180,
  },
  emptyMenuTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  emptyMenuDetail: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  outlineButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 44,
    paddingHorizontal: 13,
  },
  outlineButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  menuList: {
    gap: spacing.md,
  },
  menuSection: {
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  menuSectionTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  menuSectionNumber: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 0.7,
  },
  removeButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 6,
  },
  removeButtonText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '800',
  },
  itemsHeader: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
  },
  itemsTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  smallOutlineButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 11,
  },
  smallOutlineButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  menuItem: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  menuItemTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  menuItemNumber: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 11,
  },
  iconButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  itemNameField: {
    flexBasis: '66%',
    flexGrow: 1,
  },
  itemPriceField: {
    flexBasis: '27%',
    flexGrow: 1,
  },
  itemControls: {
    gap: spacing.md,
  },
  availabilityControl: {
    gap: 7,
  },
  controlLabel: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  segmented: {
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    padding: 3,
  },
  segment: {
    alignItems: 'center',
    borderRadius: radii.pill,
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  segmentActive: {
    backgroundColor: palette.dark,
  },
  segmentText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  segmentTextActive: {
    color: '#FFFFFF',
  },
  addSectionButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 46,
  },
  addSectionButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  submitSection: {
    alignItems: 'flex-start',
    backgroundColor: palette.dark,
    borderRadius: radii.xl,
    gap: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.xl,
  },
  submitIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 16,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  submitCopy: {
    gap: spacing.sm,
  },
  submitTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.6,
  },
  submitDetail: {
    color: palette.darkMuted,
    fontSize: 12,
    lineHeight: 19,
    maxWidth: 620,
  },
  checklist: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  checklistRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  checklistText: {
    color: palette.darkMuted,
    fontSize: 11,
  },
  checklistTextReady: {
    color: palette.mint,
    fontWeight: '800',
  },
  ownerNotice: {
    alignItems: 'flex-start',
    backgroundColor: '#263E3B',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    width: '100%',
  },
  ownerNoticeText: {
    color: palette.darkMuted,
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
  },
  submitButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 18,
  },
  submitButtonPressed: {
    backgroundColor: palette.accentDeep,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  gate: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  gateIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.pill,
    height: 54,
    justifyContent: 'center',
    marginTop: spacing.lg,
    width: 54,
  },
  gateTitle: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.5,
    maxWidth: 430,
    textAlign: 'center',
  },
  gateDetail: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 20,
    maxWidth: 500,
    textAlign: 'center',
  },
  gateButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: spacing.xl,
  },
  gateButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.48,
  },
});
