// Full onboarding implementation is lazy-loaded by the route wrapper.
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
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

import { BrandMark } from '@/components/brand-mark';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { featureFlags, filterHomeKitchenPlaces } from '@/lib/features';
import {
  createBusinessDraft,
  searchMarketplacePlaces,
  submitBusinessClaim,
  uploadBusinessLogo,
} from '@/lib/marketplace-api';
import type { LocalMedia } from '@/lib/media-upload';
import { checkProfessionalText } from '@/lib/moderation';
import { showMessage } from '@/lib/platform-dialog';
import {
  BusinessCategory,
  PaymentMethod,
  Place,
} from '@/types/marketplace';

const LazyBusinessClaimRecoveryPanel = lazy(
  () => import('@/components/business-claim-recovery-panel'),
);

type ClaimRecoveryBoundaryProps = {
  children: ReactNode;
};

type ClaimRecoveryBoundaryState = {
  failed: boolean;
};

class ClaimRecoveryBoundary extends Component<
  ClaimRecoveryBoundaryProps,
  ClaimRecoveryBoundaryState
> {
  state: ClaimRecoveryBoundaryState = { failed: false };

  static getDerivedStateFromError(): ClaimRecoveryBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (__DEV__) console.error('Claim recovery panel failed to load.', error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <View accessibilityRole="alert" style={styles.claimRecoveryError}>
          <FontAwesome6 color={palette.accentDeep} name="triangle-exclamation" size={14} />
          <View style={styles.claimRecoveryErrorCopy}>
            <Text style={styles.claimRecoveryErrorTitle}>Claim history is temporarily unavailable</Text>
            <Text style={styles.claimRecoveryErrorText}>
              You can continue adding or claiming a business. Refresh this screen later to view
              your claim history.
            </Text>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const categories: {
  id: BusinessCategory;
  label: string;
  detail: string;
  icon: keyof typeof FontAwesome6.glyphMap;
}[] = [
  { id: 'food_truck', label: 'Food truck', detail: 'Mobile or recurring stops', icon: 'truck' },
  { id: 'restaurant', label: 'Restaurant', detail: 'Permanent storefront', icon: 'utensils' },
  { id: 'pop_up', label: 'Pop-up', detail: 'Markets and temporary service', icon: 'store' },
  { id: 'cafe_bakery', label: 'Café or bakery', detail: 'Coffee, pastry, or counter', icon: 'mug-hot' },
  { id: 'home_kitchen', label: 'Neighborhood kitchen', detail: 'Permit-verified where local law allows', icon: 'house' },
];

const payments: PaymentMethod[] = [
  'Cash',
  'Visa',
  'Mastercard',
  'Amex',
  'Apple Pay',
  'Google Pay',
  'Cash App',
  'Venmo',
];

function eligibleClaimPlaces(places: readonly Place[]) {
  return filterHomeKitchenPlaces(places).filter(
    (place) =>
      place.publicationState === 'published' &&
      (place.sourceLabel === 'Licensed provider' || place.sourceLabel === 'Community added')
  );
}

type BusinessOnboardingContentProps = {
  claimRequested: boolean;
  initialClaimId: string | null;
  initialName: string;
  expectedUserId: string | null;
};

function Input({
  label,
  value,
  onChangeText,
  placeholder,
  required,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  required?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'words';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      <TextInput
        autoCapitalize={autoCapitalize ?? (keyboardType === 'email-address' ? 'none' : 'words')}
        autoCorrect={false}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.mutedLight}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

export default function BusinessOnboardingScreen() {
  const claimParams = useLocalSearchParams<{
    claim?: string | string[];
    claimId?: string | string[];
    name?: string | string[];
  }>();
  const auth = useAuth();
  const value = (input?: string | string[]) =>
    (Array.isArray(input) ? (input[0] ?? '') : (input ?? '')).trim();
  const claimRequested = value(claimParams.claim) === '1';
  const initialClaimId = value(claimParams.claimId) || null;
  const initialName = value(claimParams.name);
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
    <BusinessOnboardingContent
      claimRequested={claimRequested}
      expectedUserId={accountId}
      initialClaimId={initialClaimId}
      initialName={initialName}
      key={`${accountScope}:${accessScope}:business-onboarding:${initialClaimId ?? 'new'}:${claimRequested ? 'claim' : 'create'}:${initialName}`}
    />
  );
}

function BusinessOnboardingContent({
  claimRequested,
  expectedUserId,
  initialClaimId,
  initialName,
}: BusinessOnboardingContentProps) {
  const auth = useAuth();
  const { refreshAccess } = useMarketplaceStore();
  const [step, setStep] = useState(1);
  const [category, setCategory] = useState<BusinessCategory>('food_truck');
  const [businessName, setBusinessName] = useState(initialName);
  const [cuisine, setCuisine] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('CA');
  const [postalCode, setPostalCode] = useState('');
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
  );
  const [permitNumber, setPermitNumber] = useState('');
  const [selectedPayments, setSelectedPayments] = useState<PaymentMethod[]>(['Cash', 'Visa']);
  const [logoUri, setLogoUri] = useState<string | null>(null);
  const [logoMedia, setLogoMedia] = useState<LocalMedia | null>(null);
  const [logoUploadComplete, setLogoUploadComplete] = useState(false);
  const [createdBusinessId, setCreatedBusinessId] = useState<string | null>(null);
  const [logoMeta, setLogoMeta] = useState('');
  const [description, setDescription] = useState('');
  const [claimExisting, setClaimExisting] = useState(
    featureFlags.businessClaims && claimRequested
  );
  // A deep link is only a hint. It becomes selectable after the live search
  // returns the same published, currently eligible listing.
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [claimMethod, setClaimMethod] = useState<'listed_phone' | 'domain_email'>('listed_phone');
  const [claimSearchResults, setClaimSearchResults] = useState<Place[]>([]);
  const [claimSearching, setClaimSearching] = useState(false);
  const [claimSearchError, setClaimSearchError] = useState<string | null>(null);
  const [claimsRefreshToken, setClaimsRefreshToken] = useState(0);
  const [accuracyConfirmed, setAccuracyConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  );
  const mounted = useRef(true);
  const mutationGeneration = useRef(0);
  const mutationBusy = useRef(false);
  const navigationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      mutationGeneration.current += 1;
      mutationBusy.current = false;
      if (navigationTimer.current) clearTimeout(navigationTimer.current);
      navigationTimer.current = null;
    };
  }, []);

  const beginMutation = () => {
    if (!secureSession || !expectedUserId || mutationBusy.current) return null;
    mutationBusy.current = true;
    const generation = mutationGeneration.current + 1;
    mutationGeneration.current = generation;
    setSubmitting(true);
    setFormMessage(null);
    return generation;
  };
  const isCurrentMutation = (generation: number) =>
    mounted.current && mutationGeneration.current === generation;
  const finishMutation = (generation: number) => {
    if (!isCurrentMutation(generation)) return false;
    mutationBusy.current = false;
    setSubmitting(false);
    return true;
  };

  const visibleCategories = useMemo(
    () => categories.filter((item) => item.id !== 'home_kitchen' || featureFlags.homeKitchens),
    []
  );
  const claimMatches = claimSearchResults;

  useEffect(() => {
    let active = true;
    const unavailable =
      !auth.isConfigured ||
      !featureFlags.businessClaims ||
      !claimExisting ||
      businessName.trim().length < 2;
    const resetTimer = setTimeout(() => {
      if (!active || !mounted.current) return;
      setClaimSearchResults([]);
      setSelectedClaimId(null);
      setClaimSearchError(null);
      setClaimSearching(!unavailable);
    }, 0);
    const searchTimer = setTimeout(() => {
      if (!active || !mounted.current) return;
      if (unavailable) {
        setClaimSearchResults([]);
        setClaimSearchError(null);
        setClaimSearching(false);
        return;
      }
      setClaimSearching(true);
      setClaimSearchError(null);
      void searchMarketplacePlaces(businessName).then((result) => {
        if (!active) return;
        setClaimSearching(false);
        if (!result.ok) {
          setClaimSearchResults([]);
          setClaimSearchError(result.reason);
          setSelectedClaimId(null);
          return;
        }
        const eligibleMatches = eligibleClaimPlaces(result.data?.places ?? []);
        const deepLinkedPlace = initialClaimId
          ? eligibleMatches.find((place) => place.id === initialClaimId)
          : undefined;
        const visibleMatches = eligibleMatches.slice(0, 5);
        if (
          deepLinkedPlace &&
          !visibleMatches.some((place) => place.id === deepLinkedPlace.id)
        ) {
          visibleMatches.push(deepLinkedPlace);
        }
        setClaimSearchResults(visibleMatches);
        setSelectedClaimId(deepLinkedPlace?.id ?? null);
      });
    }, unavailable ? 0 : 450);
    return () => {
      active = false;
      clearTimeout(resetTimer);
      clearTimeout(searchTimer);
    };
  }, [auth.isConfigured, businessName, claimExisting, initialClaimId]);

  if (!auth.isConfigured) {
    return (
      <View role="main" style={styles.authGate}>
        <BrandMark />
        <View style={styles.authGateIcon}>
          <FontAwesome6 color={palette.accentDeep} name="server" size={21} />
        </View>
        <Text accessibilityRole="header" style={styles.authGateTitle}>
          Live business services are required.
        </Text>
        <Text style={styles.authGateDetail}>
          This build cannot create or claim listings until the secured backend, verification service, and audit trail are configured.
        </Text>
      </View>
    );
  }

  if (auth.status === 'loading') {
    return (
      <View role="main" style={styles.authGate}>
        <ActivityIndicator color={palette.accentDeep} />
        <Text style={styles.authGateDetail}>Checking secure business access…</Text>
      </View>
    );
  }

  if (auth.status !== 'authenticated') {
    return (
      <View role="main" style={styles.authGate}>
        <BrandMark />
        <View style={styles.authGateIcon}>
          <FontAwesome6 color={palette.accentDeep} name="user-shield" size={21} />
        </View>
        <Text accessibilityRole="header" style={styles.authGateTitle}>
          Sign in before adding a business.
        </Text>
        <Text style={styles.authGateDetail}>
          A verified account is required for ownership checks, audit history, and protected business details.
        </Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/auth')} style={styles.authGateButton}>
          <Text style={styles.authGateButtonText}>Sign in or create account</Text>
        </Pressable>
      </View>
    );
  }

  if (auth.securityStatus === 'loading') {
    return (
      <View role="main" style={styles.authGate}>
        <ActivityIndicator color={palette.accentDeep} />
        <Text style={styles.authGateDetail}>Checking authenticator security…</Text>
      </View>
    );
  }

  if (
    auth.securityStatus !== 'ready' ||
    !auth.mfaEnrolled ||
    auth.assuranceLevel !== 'aal2'
  ) {
    return (
      <View role="main" style={styles.authGate}>
        <BrandMark />
        <View style={styles.authGateIcon}>
          <FontAwesome6
            color={palette.accentDeep}
            name="mobile-screen-button"
            size={21}
          />
        </View>
        <Text accessibilityRole="header" style={styles.authGateTitle}>
          Verify your authenticator first.
        </Text>
        <Text style={styles.authGateDetail}>
          Business drafts, ownership claims, permits, and logos are protected by
          a current authenticator code. Verify once before entering setup details.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/security')}
          style={styles.authGateButton}>
          <Text style={styles.authGateButtonText}>Open security</Text>
        </Pressable>
      </View>
    );
  }

  const pickLogo = async () => {
    if (auth.isConfigured && !featureFlags.mediaUploads) {
      showMessage(
        'Secure uploads are not active',
        'Logo upload stays disabled until the private scanning service is connected. You can still submit the business draft.'
      );
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!mounted.current) return;
    if (!permission.granted) {
      showMessage('Photo access needed', 'Allow photo access to choose a business logo.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ['images'],
      quality: 0.9,
    });

    if (!mounted.current) return;

    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (asset.mimeType && !allowedTypes.includes(asset.mimeType)) {
      showMessage('Unsupported logo', 'Choose a JPEG, PNG, or WebP image.');
      return;
    }

    if (
      (asset.width ?? 0) < 512 ||
      (asset.height ?? 0) < 512 ||
      (asset.width ?? 0) > 2048 ||
      (asset.height ?? 0) > 2048 ||
      Math.abs((asset.width ?? 0) - (asset.height ?? 0)) > 2
    ) {
      showMessage('Logo size needs attention', 'Choose a square image between 512 × 512 and 2048 × 2048 pixels.');
      return;
    }

    if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024) {
      showMessage('Logo is too large', 'Choose an image under 5 MB.');
      return;
    }

    setLogoUri(asset.uri);
    setLogoMedia({
      uri: asset.uri,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
    });
    setLogoUploadComplete(false);
    setLogoMeta(`${asset.width} × ${asset.height} · ready for safe processing`);
  };

  const togglePayment = (payment: PaymentMethod) => {
    setSelectedPayments((current) =>
      current.includes(payment) ? current.filter((item) => item !== payment) : [...current, payment]
    );
  };

  const next = () => {
    setFormMessage(null);
    if (step === 1) {
      const nameCheck = checkProfessionalText(businessName, 80);
      if (claimExisting && !selectedClaimId) {
        setFormMessage({ type: 'error', text: 'Choose the existing listing you are authorized to claim.' });
        return;
      }
      if (!nameCheck.ok || !cuisine.trim() || !email.trim() || !phone.trim()) {
        setFormMessage({
          type: 'error',
          text: nameCheck.ok ? 'Add cuisine, email, and business phone.' : nameCheck.reason,
        });
        return;
      }
    }

    if (step === 2) {
      if (!city.trim() || !region.trim() || !postalCode.trim() || !timezone.trim()) {
        setFormMessage({ type: 'error', text: 'Add the operating city, state, ZIP code, and time zone.' });
        return;
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() }).format();
      } catch {
        setFormMessage({ type: 'error', text: 'Use a valid IANA time zone, such as America/Los_Angeles.' });
        return;
      }
      if (
        (category === 'restaurant' || category === 'cafe_bakery') &&
        !address.trim()
      ) {
        setFormMessage({ type: 'error', text: 'A public storefront needs a complete address.' });
        return;
      }
      if (category === 'home_kitchen' && !permitNumber.trim()) {
        setFormMessage({
          type: 'error',
          text: 'Home kitchens remain private until local eligibility and permit status are verified.',
        });
        return;
      }
      if (!selectedPayments.length) {
        setFormMessage({ type: 'error', text: 'Select at least one accepted payment method.' });
        return;
      }
    }

    setStep((current) => Math.min(3, current + 1));
  };

  const submit = async () => {
    if (!expectedUserId || auth.status !== 'authenticated') {
      setFormMessage({ type: 'error', text: 'Sign in before creating a business draft.' });
      router.push('/auth');
      return;
    }
    if (
      auth.isConfigured &&
      (auth.securityStatus !== 'ready' || !auth.mfaEnrolled || auth.assuranceLevel !== 'aal2')
    ) {
      setFormMessage({
        type: 'error',
        text: 'Connect and verify an authenticator before creating a business draft.',
      });
      router.push('/security');
      return;
    }
    const descriptionCheck = checkProfessionalText(description, 280);
    const logoRequired = !auth.isConfigured || featureFlags.mediaUploads;
    if ((logoRequired && !logoUri) || !descriptionCheck.ok || !accuracyConfirmed) {
      setFormMessage({
        type: 'error',
        text:
          logoRequired && !logoUri
            ? 'Add a square business logo.'
            : !descriptionCheck.ok
              ? descriptionCheck.reason
              : 'Confirm that the information is accurate and authorized.',
      });
      return;
    }

    const generation = beginMutation();
    if (generation === null) return;
    let businessId = createdBusinessId;
    let successMessage = 'Business draft created.';
    if (!businessId) {
      const result = await createBusinessDraft(
        {
          kind: category,
          name: businessName,
          description: descriptionCheck.clean,
          cuisines: cuisine.split(','),
          businessEmail: email,
          businessPhone: phone,
          websiteUrl: website,
          address,
          city,
          region,
          postalCode,
          timezone,
          payments: selectedPayments,
          permitNumber: category === 'home_kitchen' ? permitNumber : undefined,
        },
        expectedUserId
      );
      if (!isCurrentMutation(generation)) return;
      if (!result.ok) {
        finishMutation(generation);
        setFormMessage({ type: 'error', text: result.reason });
        return;
      }
      businessId = result.data?.businessId ?? null;
      if (auth.isConfigured && !businessId) {
        finishMutation(generation);
        setFormMessage({
          type: 'error',
          text: 'The business draft was saved without a usable identifier. Contact support before retrying.',
        });
        return;
      }
      setCreatedBusinessId(businessId);
      successMessage = result.message ?? successMessage;
    }

    if (
      auth.isConfigured &&
      featureFlags.mediaUploads &&
      businessId &&
      logoMedia &&
      !logoUploadComplete
    ) {
      const logoResult = await uploadBusinessLogo(
        businessId,
        logoMedia,
        expectedUserId
      );
      if (!isCurrentMutation(generation)) return;
      if (!logoResult.ok) {
        finishMutation(generation);
        setFormMessage({
          type: 'error',
          text: `Your business draft is safely saved, but its logo was not attached. ${logoResult.reason} Press Submit again to retry the logo without creating another draft.`,
        });
        return;
      }
      setLogoUploadComplete(true);
      successMessage = `${successMessage} ${logoResult.message ?? ''}`.trim();
    }

    await refreshAccess();
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    setFormMessage({ type: 'success', text: successMessage });
    navigationTimer.current = setTimeout(
      () => {
        if (!isCurrentMutation(generation)) return;
        router.replace(
          businessId
            ? { pathname: '/business-setup', params: { businessId } }
            : '/(tabs)/studio'
        );
      },
      500
    );
  };

  const submitClaim = async () => {
    setFormMessage(null);
    if (!featureFlags.businessClaims) {
      setClaimExisting(false);
      setSelectedClaimId(null);
      setFormMessage({
        type: 'error',
        text: 'Ownership claims stay closed until secure verification is connected. Add a new business instead.',
      });
      return;
    }
    if (!expectedUserId || auth.status !== 'authenticated') {
      setFormMessage({ type: 'error', text: 'Sign in before claiming a business.' });
      router.push('/auth');
      return;
    }
    if (
      auth.isConfigured &&
      (auth.securityStatus !== 'ready' || !auth.mfaEnrolled || auth.assuranceLevel !== 'aal2')
    ) {
      setFormMessage({
        type: 'error',
        text: 'Connect and verify an authenticator before submitting a business claim.',
      });
      router.push('/security');
      return;
    }
    if (!selectedClaimId) {
      setFormMessage({ type: 'error', text: 'Choose an existing listing first.' });
      return;
    }
    const selectedClaim = claimMatches.find((place) => place.id === selectedClaimId);
    if (!selectedClaim || selectedClaim.publicationState !== 'published') {
      setSelectedClaimId(null);
      setFormMessage({
        type: 'error',
        text: 'Choose an eligible published listing from the results before continuing.',
      });
      return;
    }
    if (!accuracyConfirmed) {
      setFormMessage({
        type: 'error',
        text: 'Confirm that you are authorized to represent this business.',
      });
      return;
    }
    const targetClaimId = selectedClaimId;
    const targetClaimMethod = claimMethod;
    const generation = beginMutation();
    if (generation === null) return;
    const result = await submitBusinessClaim(
      targetClaimId,
      targetClaimMethod,
      expectedUserId
    );
    if (!isCurrentMutation(generation) || !finishMutation(generation)) return;
    if (!result.ok) {
      setFormMessage({ type: 'error', text: result.reason });
      return;
    }
    setClaimsRefreshToken((current) => current + 1);
    setFormMessage({ type: 'success', text: result.message ?? 'Claim submitted for verification.' });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={24}
      style={styles.keyboard}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Go back" onPress={() => router.back()} style={styles.backButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={14} />
            </Pressable>
            <BrandMark />
            <View style={styles.backSpacer} />
          </View>

          <View style={styles.progressHeader}>
            <Text style={styles.progressEyebrow}>Business verification</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {step === 1 ? 'Tell us what you serve.' : step === 2 ? 'Where and how do you operate?' : 'Make it unmistakably yours.'}
            </Text>
            <Text style={styles.subtitle}>
              {step === 1
                ? 'Start a new listing or claim one that already appears in discovery.'
                : step === 2
                  ? 'Accurate location, permit, and payment details build customer trust.'
                  : 'A clean logo and a short description complete the public profile.'}
            </Text>
            <View style={styles.progress}>
              {[1, 2, 3].map((item) => (
                <View key={item} style={[styles.progressBar, item <= step && styles.progressBarActive]} />
              ))}
            </View>
            <Text style={styles.stepLabel}>Step {step} of 3</Text>
          </View>

          <View style={styles.formPanel}>
            {step === 1 ? (
              <>
                <View style={styles.modeRow}>
                  <Pressable
                    accessibilityRole="radio"
                    aria-checked={!claimExisting}
                    accessibilityState={{ checked: !claimExisting }}
                    onPress={() => {
                      setClaimExisting(false);
                      setSelectedClaimId(null);
                    }}
                    style={[styles.modeOption, !claimExisting && styles.modeOptionActive]}>
                    <Text style={[styles.modeText, !claimExisting && styles.modeTextActive]}>Add new</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="radio"
                    aria-checked={claimExisting}
                    accessibilityState={{ checked: claimExisting, disabled: !featureFlags.businessClaims }}
                    disabled={!featureFlags.businessClaims}
                    onPress={() => {
                      setClaimExisting(true);
                      setSelectedClaimId(null);
                    }}
                    style={[
                      styles.modeOption,
                      claimExisting && styles.modeOptionActive,
                      !featureFlags.businessClaims && styles.modeOptionDisabled,
                    ]}>
                    <Text style={[styles.modeText, claimExisting && styles.modeTextActive]}>
                      {featureFlags.businessClaims ? 'Claim existing' : 'Claim verification closed'}
                    </Text>
                  </Pressable>
                </View>

                {featureFlags.businessClaims ? (
                  <ClaimRecoveryBoundary>
                    <Suspense
                      fallback={
                        <View accessibilityLiveRegion="polite" style={styles.claimRecoveryFallback}>
                          <ActivityIndicator color={palette.accentDeep} size="small" />
                          <Text style={styles.claimRecoveryFallbackText}>Loading ownership claims…</Text>
                        </View>
                      }>
                      <LazyBusinessClaimRecoveryPanel
                        expectedUserId={expectedUserId}
                        refreshToken={claimsRefreshToken}
                        secureSession={secureSession}
                        submitting={submitting}
                      />
                    </Suspense>
                  </ClaimRecoveryBoundary>
                ) : null}

                {!featureFlags.businessClaims ? (
                  <View style={styles.claimUnavailable}>
                    <FontAwesome6 color={palette.accentDeep} name="shield-halved" size={15} />
                    <View style={styles.claimUnavailableCopy}>
                      <Text style={styles.claimUnavailableTitle}>Ownership stays protected</Text>
                      <Text style={styles.claimUnavailableText}>
                        Existing listings cannot transfer control without verified proof. You can still add a new business.
                      </Text>
                    </View>
                  </View>
                ) : null}

                <View style={styles.field}>
                  <Text style={styles.label}>Business category *</Text>
                  <View style={styles.categoryList}>
                    {visibleCategories.map((item) => {
                      const active = category === item.id;
                      return (
                        <Pressable
                          key={item.id}
                          onPress={() => setCategory(item.id)}
                          style={[styles.categoryOption, active && styles.categoryOptionActive]}>
                          <View style={[styles.categoryIcon, active && styles.categoryIconActive]}>
                            <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={item.icon} size={14} />
                          </View>
                          <View style={styles.categoryCopy}>
                            <Text style={[styles.categoryTitle, active && styles.categoryTitleActive]}>{item.label}</Text>
                            <Text style={[styles.categoryDetail, active && styles.categoryDetailActive]}>{item.detail}</Text>
                          </View>
                          {active ? <FontAwesome6 color={palette.mint} name="circle-check" size={13} solid /> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {category === 'home_kitchen' ? (
                  <View style={styles.legalNotice}>
                    <FontAwesome6 color={palette.warning} name="scale-balanced" size={16} />
                    <View style={styles.legalCopy}>
                      <Text style={styles.legalTitle}>Legal availability varies by location</Text>
                      <Text style={styles.legalText}>
                        Your residence and exact pickup point stay private. The listing cannot publish until Spottr verifies
                        local eligibility, permit status, and allowed food categories.
                      </Text>
                    </View>
                  </View>
                ) : null}

                <Input
                  label="Business name"
                  onChangeText={setBusinessName}
                  placeholder="The public business name"
                  required
                  value={businessName}
                />
                {claimExisting ? (
                  <View style={styles.claimResults}>
                    <Text style={styles.claimResultsLabel}>Choose the listing to claim</Text>
                    {claimSearching ? (
                      <View style={styles.claimSearchStatus}>
                        <ActivityIndicator color={palette.accentDeep} size="small" />
                        <Text style={styles.claimEmpty}>Searching verified directory…</Text>
                      </View>
                    ) : null}
                    {claimMatches.map((place) => {
                      const selected = place.id === selectedClaimId;
                      return (
                        <Pressable
                          accessibilityRole="radio"
                          aria-checked={selected}
                          accessibilityState={{ checked: selected }}
                          key={place.id}
                          onPress={() => {
                            setSelectedClaimId(place.id);
                            setBusinessName(place.name);
                            setCategory(place.category);
                            setCuisine(place.cuisines.join(', '));
                          }}
                          style={[styles.claimResult, selected && styles.claimResultSelected]}>
                          <View style={styles.claimResultCopy}>
                            <Text style={[styles.claimResultName, selected && styles.claimResultNameSelected]}>
                              {place.name}
                            </Text>
                            <Text style={[styles.claimResultMeta, selected && styles.claimResultMetaSelected]}>
                              {place.categoryLabel} · {place.city} · {place.address}
                            </Text>
                          </View>
                          {selected ? (
                            <FontAwesome6 color={palette.mint} name="circle-check" size={15} solid />
                          ) : null}
                        </Pressable>
                      );
                    })}
                    {claimSearchError ? (
                      <Text accessibilityRole="alert" style={styles.claimEmpty}>{claimSearchError}</Text>
                    ) : businessName.trim().length >= 2 && !claimSearching && !claimMatches.length ? (
                      <Text style={styles.claimEmpty}>
                        No matching listing. Choose “Add new” to create it instead.
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                {!claimExisting ? (
                  <>
                    <Input
                      label="Cuisine or specialty"
                      onChangeText={setCuisine}
                      placeholder="Example: Sonoran tacos"
                      required
                      value={cuisine}
                    />
                    <Input
                      keyboardType="email-address"
                      label="Business email"
                      onChangeText={setEmail}
                      placeholder="owner@business.com"
                      required
                      value={email}
                    />
                    <Input
                      keyboardType="phone-pad"
                      label="Business phone"
                      onChangeText={setPhone}
                      placeholder="Used for private ownership checks"
                      required
                      value={phone}
                    />
                    <Input
                      label="Website or social page"
                      onChangeText={setWebsite}
                      placeholder="Optional"
                      value={website}
                    />
                  </>
                ) : selectedClaimId ? (
                  <View style={styles.claimMethodPanel}>
                    <Text style={styles.label}>Verification method</Text>
                    <Text style={styles.claimMethodDetail}>
                      This request is checked against contact information already associated with the listing. No
                      challenge is sent until the production verification service is connected.
                    </Text>
                    {(
                      [
                        ['listed_phone', 'Listed business phone'],
                        ['domain_email', 'Business-domain email'],
                      ] as const
                    ).map(([id, label]) => (
                      <Pressable
                        accessibilityRole="radio"
                        aria-checked={claimMethod === id}
                        accessibilityState={{ checked: claimMethod === id }}
                        key={id}
                        onPress={() => setClaimMethod(id)}
                        style={[styles.claimMethod, claimMethod === id && styles.claimMethodActive]}>
                        <View style={[styles.radioCircle, claimMethod === id && styles.radioCircleActive]}>
                          {claimMethod === id ? <View style={styles.radioDot} /> : null}
                        </View>
                        <Text
                          style={[
                            styles.claimMethodText,
                            claimMethod === id && styles.claimMethodTextActive,
                          ]}>
                          {label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {claimExisting ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    aria-checked={accuracyConfirmed}
                    accessibilityState={{ checked: accuracyConfirmed }}
                    onPress={() => setAccuracyConfirmed((current) => !current)}
                    style={styles.confirmRow}>
                    <View style={[styles.checkbox, accuracyConfirmed && styles.checkboxActive]}>
                      {accuracyConfirmed ? <FontAwesome6 color="#FFFFFF" name="check" size={10} /> : null}
                    </View>
                    <Text style={styles.confirmText}>
                      I’m authorized to represent the selected business and understand Spottr will verify this claim.
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}

            {step === 2 ? (
              <>
                {category === 'food_truck' || category === 'pop_up' ? (
                  <View style={styles.locationMode}>
                    <FontAwesome6 color={palette.accent} name="route" size={18} />
                    <View style={styles.locationModeCopy}>
                      <Text style={styles.locationModeTitle}>Mobile location schedule</Text>
                      <Text style={styles.locationModeText}>
                        Add today’s stop now. Recurring weekly stops and future dates can be managed after verification.
                      </Text>
                    </View>
                  </View>
                ) : null}

                <Input
                  label={category === 'home_kitchen' ? 'Public service area' : 'Street address / current stop'}
                  onChangeText={setAddress}
                  placeholder={category === 'home_kitchen' ? 'Example: Highland Park' : 'Address or named lot'}
                  required={category === 'restaurant' || category === 'cafe_bakery'}
                  value={address}
                />
                <Input label="City" onChangeText={setCity} placeholder="City" required value={city} />
                <View style={styles.inlineFields}>
                  <View style={styles.inlineField}>
                    <Input label="State" onChangeText={setRegion} placeholder="CA" required value={region} />
                  </View>
                  <View style={styles.inlineField}>
                    <Input
                      label="ZIP code"
                      onChangeText={setPostalCode}
                      placeholder="90026"
                      required
                      value={postalCode}
                    />
                  </View>
                </View>

                <Input
                  autoCapitalize="none"
                  label="Location time zone"
                  onChangeText={setTimezone}
                  placeholder="America/Los_Angeles"
                  required
                  value={timezone}
                />
                <Text style={styles.fieldDetail}>
                  Used to calculate “open now” correctly. Use an IANA name such as America/Chicago.
                </Text>

                {category === 'home_kitchen' ? (
                  <Input
                    label="Permit or registration number"
                    onChangeText={setPermitNumber}
                    placeholder="Kept private during verification"
                    required
                    value={permitNumber}
                  />
                ) : null}

                <View style={styles.field}>
                  <Text style={styles.label}>Accepted payments *</Text>
                  <Text style={styles.fieldDetail}>Select every method customers can use today.</Text>
                  <View style={styles.paymentList}>
                    {payments.map((payment) => {
                      const active = selectedPayments.includes(payment);
                      return (
                        <Pressable
                          key={payment}
                          onPress={() => togglePayment(payment)}
                          style={[styles.paymentOption, active && styles.paymentOptionActive]}>
                          <View style={[styles.smallCheckbox, active && styles.smallCheckboxActive]}>
                            {active ? <FontAwesome6 color="#FFFFFF" name="check" size={8} /> : null}
                          </View>
                          <Text style={[styles.paymentText, active && styles.paymentTextActive]}>{payment}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.verificationNote}>
                  <FontAwesome6 color={palette.success} name="user-shield" size={16} />
                  <Text style={styles.verificationText}>
                    Claims use a code sent to an already-listed business phone or domain email when possible. Documents stay
                    private and are removed under the verification retention policy.
                  </Text>
                </View>
              </>
            ) : null}

            {step === 3 ? (
              <>
                <View style={styles.logoSection}>
                  <View style={styles.logoPreview}>
                    {logoUri ? (
                      <Image source={{ uri: logoUri }} style={styles.logoImage} />
                    ) : (
                      <FontAwesome6 color={palette.mutedLight} name="image" size={27} />
                    )}
                  </View>
                  <View style={styles.logoCopy}>
                    <Text style={styles.label}>
                      Business logo {!auth.isConfigured || featureFlags.mediaUploads ? '*' : '(optional for now)'}
                    </Text>
                    <Text style={styles.logoRequirements}>
                      {auth.isConfigured && !featureFlags.mediaUploads
                        ? 'Secure logo upload unlocks only when scanning and re-encoding are connected.'
                        : 'Square PNG, JPEG, or WebP · 512–2048 px · up to 5 MB'}
                    </Text>
                    {logoMeta ? <Text style={styles.logoSuccess}>{logoMeta}</Text> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled: auth.isConfigured && !featureFlags.mediaUploads,
                      }}
                      disabled={auth.isConfigured && !featureFlags.mediaUploads}
                      onPress={pickLogo}
                      style={[
                        styles.logoButton,
                        auth.isConfigured && !featureFlags.mediaUploads && styles.primaryButtonDisabled,
                      ]}>
                      <FontAwesome6 color={palette.ink} name="upload" size={11} />
                      <Text style={styles.logoButtonText}>
                        {auth.isConfigured && !featureFlags.mediaUploads
                          ? 'Upload unavailable'
                          : logoUri
                            ? 'Choose another'
                            : 'Choose logo'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.field}>
                  <View style={styles.fieldHeader}>
                    <Text style={styles.label}>Short description *</Text>
                    <Text style={styles.fieldDetail}>{description.length}/280</Text>
                  </View>
                  <TextInput
                    maxLength={280}
                    multiline
                    onChangeText={setDescription}
                    placeholder="Tell customers what makes your food and business distinct."
                    placeholderTextColor={palette.mutedLight}
                    style={[styles.input, styles.descriptionInput]}
                    textAlignVertical="top"
                    value={description}
                  />
                </View>

                <View style={styles.reviewSummary}>
                  <Text style={styles.reviewTitle}>Ready for verification</Text>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Business</Text>
                    <Text style={styles.reviewValue}>{businessName || 'Not added'}</Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Category</Text>
                    <Text style={styles.reviewValue}>
                      {categories.find((item) => item.id === category)?.label}
                    </Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Operation</Text>
                    <Text style={styles.reviewValue}>
                      {category === 'food_truck' || category === 'pop_up' ? 'Mobile schedule' : city || 'Location pending'}
                    </Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Payments</Text>
                    <Text style={styles.reviewValue}>{selectedPayments.length} selected</Text>
                  </View>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Time zone</Text>
                    <Text style={styles.reviewValue}>{timezone}</Text>
                  </View>
                </View>

                <Pressable
                  accessibilityRole="checkbox"
                  aria-checked={accuracyConfirmed}
                  accessibilityState={{ checked: accuracyConfirmed }}
                  onPress={() => setAccuracyConfirmed((current) => !current)}
                  style={styles.confirmRow}>
                  <View style={[styles.checkbox, accuracyConfirmed && styles.checkboxActive]}>
                    {accuracyConfirmed ? <FontAwesome6 color="#FFFFFF" name="check" size={10} /> : null}
                  </View>
                  <Text style={styles.confirmText}>
                    I’m authorized to represent this business, and the information is accurate. I understand public updates and
                    menu details must remain professional and current.
                  </Text>
                </Pressable>
              </>
            ) : null}

            {formMessage ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={[styles.formMessage, formMessage.type === 'success' && styles.formMessageSuccess]}>
                <FontAwesome6
                  color={formMessage.type === 'success' ? palette.success : palette.accentDeep}
                  name={formMessage.type === 'success' ? 'circle-check' : 'triangle-exclamation'}
                  size={13}
                  solid
                />
                <Text
                  style={[
                    styles.formMessageText,
                    formMessage.type === 'success' && styles.formMessageTextSuccess,
                  ]}>
                  {formMessage.text}
                </Text>
              </View>
            ) : null}

            <View style={styles.actions}>
              {step > 1 ? (
                <Pressable onPress={() => setStep((current) => current - 1)} style={styles.secondaryButton}>
                  <FontAwesome6 color={palette.ink} name="arrow-left" size={11} />
                  <Text style={styles.secondaryButtonText}>Back</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => router.back()} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              )}

              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={claimExisting && step === 1 ? submitClaim : step === 3 ? submit : next}
                style={[styles.primaryButton, submitting && styles.primaryButtonDisabled]}>
                {submitting ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>
                      {claimExisting && step === 1
                        ? 'Submit ownership claim'
                        : step === 3
                          ? 'Submit for verification'
                          : 'Continue'}
                    </Text>
                    <FontAwesome6 color="#FFFFFF" name="arrow-right" size={11} />
                  </>
                )}
              </Pressable>
            </View>
          </View>
        </PageShell>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  authGate: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  authGateIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 54,
    justifyContent: 'center',
    marginTop: spacing.lg,
    width: 54,
  },
  authGateTitle: {
    color: palette.ink,
    fontSize: 25,
    fontWeight: '900',
    letterSpacing: -0.7,
    maxWidth: 420,
    textAlign: 'center',
  },
  authGateDetail: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 480,
    textAlign: 'center',
  },
  authGateButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.xl,
  },
  authGateButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  keyboard: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: 64,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  backSpacer: {
    width: 40,
  },
  progressHeader: {
    gap: spacing.sm,
    marginTop: spacing.xxxl,
  },
  progressEyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 39,
    fontWeight: '900',
    letterSpacing: -1.8,
    lineHeight: 42,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 600,
  },
  progress: {
    flexDirection: 'row',
    gap: 6,
    marginTop: spacing.md,
  },
  progressBar: {
    backgroundColor: palette.line,
    borderRadius: 999,
    flex: 1,
    height: 5,
  },
  progressBarActive: {
    backgroundColor: palette.accent,
  },
  stepLabel: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 9,
  },
  formPanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    marginTop: spacing.xl,
    padding: spacing.xl,
  },
  modeRow: {
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    padding: 4,
  },
  modeOption: {
    alignItems: 'center',
    borderRadius: radii.pill,
    flex: 1,
    minHeight: 44,
    paddingVertical: 10,
  },
  modeOptionActive: {
    backgroundColor: palette.card,
  },
  modeOptionDisabled: {
    opacity: 0.56,
  },
  modeText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '900',
  },
  modeTextActive: {
    color: palette.ink,
  },
  claimRecoveryFallback: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 96,
    padding: spacing.md,
  },
  claimRecoveryFallbackText: {
    color: palette.muted,
    fontSize: 12,
  },
  claimRecoveryError: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderColor: palette.accentDeep,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  claimRecoveryErrorCopy: {
    flex: 1,
    gap: 3,
  },
  claimRecoveryErrorTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  claimRecoveryErrorText: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  claimUnavailable: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  claimUnavailableCopy: {
    flex: 1,
    gap: 3,
  },
  claimUnavailableTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  claimUnavailableText: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  field: {
    gap: 8,
  },
  claimResults: {
    gap: spacing.sm,
  },
  claimResultsLabel: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  claimSearchStatus: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  claimResult: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 58,
    padding: spacing.md,
  },
  claimResultSelected: {
    backgroundColor: palette.dark,
    borderColor: palette.dark,
  },
  claimResultCopy: {
    flex: 1,
    gap: 4,
  },
  claimResultName: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  claimResultNameSelected: {
    color: '#FFFFFF',
  },
  claimResultMeta: {
    color: palette.muted,
    fontSize: 11,
  },
  claimResultMetaSelected: {
    color: palette.darkMuted,
  },
  claimEmpty: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  claimMethodPanel: {
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  claimMethodDetail: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  claimMethod: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  claimMethodActive: {
    backgroundColor: palette.dark,
    borderColor: palette.dark,
  },
  claimMethodText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  claimMethodTextActive: {
    color: '#FFFFFF',
  },
  radioCircle: {
    alignItems: 'center',
    borderColor: palette.mutedLight,
    borderRadius: 999,
    borderWidth: 2,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  radioCircleActive: {
    borderColor: palette.mint,
  },
  radioDot: {
    backgroundColor: palette.mint,
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  fieldHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  label: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  required: {
    color: palette.accent,
  },
  fieldDetail: {
    color: palette.muted,
    fontSize: 9,
    lineHeight: 14,
  },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  categoryList: {
    gap: spacing.sm,
  },
  categoryOption: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  categoryOptionActive: {
    backgroundColor: palette.dark,
    borderColor: palette.dark,
  },
  categoryIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  categoryIconActive: {
    backgroundColor: palette.accent,
  },
  categoryCopy: {
    flex: 1,
    gap: 3,
  },
  categoryTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  categoryTitleActive: {
    color: '#FFFFFF',
  },
  categoryDetail: {
    color: palette.muted,
    fontSize: 9,
  },
  categoryDetailActive: {
    color: palette.darkMuted,
  },
  legalNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  legalCopy: {
    flex: 1,
    gap: 4,
  },
  legalTitle: {
    color: palette.warning,
    fontSize: 11,
    fontWeight: '900',
  },
  legalText: {
    color: palette.warning,
    fontSize: 9,
    lineHeight: 15,
  },
  locationMode: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  locationModeCopy: {
    flex: 1,
    gap: 4,
  },
  locationModeTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  locationModeText: {
    color: palette.muted,
    fontSize: 9,
    lineHeight: 15,
  },
  inlineFields: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  inlineField: {
    flex: 1,
  },
  paymentList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  paymentOption: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  paymentOptionActive: {
    backgroundColor: palette.successSoft,
    borderColor: palette.successSoft,
  },
  smallCheckbox: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 4,
    borderWidth: 1,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  smallCheckboxActive: {
    backgroundColor: palette.success,
    borderColor: palette.success,
  },
  paymentText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: '800',
  },
  paymentTextActive: {
    color: palette.success,
  },
  verificationNote: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  verificationText: {
    color: palette.success,
    flex: 1,
    fontSize: 9,
    lineHeight: 15,
  },
  logoSection: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.lg,
  },
  logoPreview: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderStyle: 'dashed',
    borderWidth: 1,
    height: 118,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 118,
  },
  logoImage: {
    height: '100%',
    width: '100%',
  },
  logoCopy: {
    flex: 1,
    gap: 7,
  },
  logoRequirements: {
    color: palette.muted,
    fontSize: 9,
    lineHeight: 14,
  },
  logoSuccess: {
    color: palette.success,
    fontSize: 9,
    fontWeight: '800',
  },
  logoButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  logoButtonText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '900',
  },
  descriptionInput: {
    minHeight: 120,
    paddingTop: 14,
  },
  reviewSummary: {
    backgroundColor: palette.bg,
    borderRadius: radii.lg,
    gap: spacing.sm,
    padding: spacing.md,
  },
  reviewTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 3,
  },
  reviewRow: {
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  reviewLabel: {
    color: palette.muted,
    fontSize: 10,
  },
  reviewValue: {
    color: palette.ink,
    flex: 1,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'right',
  },
  confirmRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  checkbox: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 6,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  checkboxActive: {
    backgroundColor: palette.success,
    borderColor: palette.success,
  },
  confirmText: {
    color: palette.muted,
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  formMessage: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  formMessageSuccess: {
    backgroundColor: palette.successSoft,
  },
  formMessageText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  formMessageTextSuccess: {
    color: palette.success,
  },
  actions: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingTop: spacing.lg,
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  secondaryButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 156,
    paddingHorizontal: 17,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  primaryButtonDisabled: {
    opacity: 0.58,
  },
});
