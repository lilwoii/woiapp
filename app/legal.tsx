import { useLocalSearchParams } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';

import { InfoScreen, InfoSection } from '@/components/info-screen';
import { palette, radii, spacing } from '@/constants/theme';

type PolicyIcon =
  | 'ban'
  | 'circle-check'
  | 'comments'
  | 'copyright'
  | 'database'
  | 'flag'
  | 'lock'
  | 'shield-halved'
  | 'user-shield';

type PolicyDocument = {
  eyebrow: string;
  title: string;
  summary: string;
  sections: { icon: PolicyIcon; title: string; body: string }[];
};

const documents = {
  terms: {
    eyebrow: 'Terms',
    title: 'Clear rules for using Spottr.',
    summary: 'A plain-language product draft that requires jurisdiction-specific legal review before public release.',
    sections: [
      {
        icon: 'circle-check',
        title: 'Accurate participation',
        body:
          'Members must provide truthful account information. Businesses must be authorized and keep their hours, locations, menus, prices, and accepted payments current.',
      },
      {
        icon: 'copyright',
        title: 'Your content',
        body:
          'Upload only content you own or may lawfully share. You grant Spottr the limited rights needed to host, moderate, display, and distribute approved content within the service.',
      },
      {
        icon: 'shield-halved',
        title: 'Service protection',
        body:
          'Spottr may restrict content, listings, or accounts to protect people, comply with law, and preserve marketplace integrity. Final terms must define disputes, warranties, liability, and governing law.',
      },
    ],
  },
  privacy: {
    eyebrow: 'Privacy policy',
    title: 'Data collection with restraint.',
    summary: 'This product disclosure describes current data flows; counsel and configured vendors must finalize it before launch.',
    sections: [
      {
        icon: 'database',
        title: 'Data Spottr needs',
        body:
          'Spottr processes account details, saved businesses, alert choices, reviews, reports, and business-management records. Nearby search coordinates are processed to return results but are not written to a customer profile.',
      },
      {
        icon: 'lock',
        title: 'Access and sharing',
        body:
          'Private account, claim, report, and exact-location data are restricted by role-based database rules. Production providers process data only for hosting, authentication, maps, notifications, and security as configured.',
      },
      {
        icon: 'user-shield',
        title: 'Your choices',
        body:
          'Members can manage followed-place alerts, export account data, request deletion, and change device location permissions. The final policy must list vendor retention, regional rights, and a privacy contact.',
      },
    ],
  },
  community: {
    eyebrow: 'Community rules',
    title: 'Keep local food discovery useful.',
    summary: 'Professional, firsthand, relevant contributions make Spottr trustworthy for customers and businesses.',
    sections: [
      {
        icon: 'comments',
        title: 'Be firsthand and relevant',
        body:
          'Describe your genuine experience with the food or service. Keep updates concise, useful, and related to the listing. Do not impersonate another person or business.',
      },
      {
        icon: 'ban',
        title: 'Prohibited content',
        body:
          'Harassment, hate, threats, sexual content, fraud, spam, review manipulation, undisclosed conflicts, private information, and unlawful material are not allowed.',
      },
      {
        icon: 'flag',
        title: 'Reports and enforcement',
        body:
          'Use in-app reporting for suspected violations. Spottr may limit distribution or access while authorized operators review safety, fraud, legal, and marketplace-integrity concerns.',
      },
    ],
  },
} satisfies Record<string, PolicyDocument>;

type DocumentKey = keyof typeof documents;
const officialPolicyUrls: Record<DocumentKey, string | undefined> = {
  terms: process.env.EXPO_PUBLIC_TERMS_URL,
  privacy: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
  community: process.env.EXPO_PUBLIC_COMMUNITY_RULES_URL,
};

function safePolicyUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export default function LegalScreen() {
  const { document } = useLocalSearchParams<{ document?: string }>();
  const selectedDocument: DocumentKey =
    typeof document === 'string' && document in documents ? (document as DocumentKey) : 'terms';
  const content: PolicyDocument = documents[selectedDocument];
  const officialUrl = safePolicyUrl(officialPolicyUrls[selectedDocument]);

  return (
    <InfoScreen eyebrow={content.eyebrow} summary={content.summary} title={content.title}>
      {officialUrl ? (
        <Pressable
          accessibilityHint="Opens the controlling policy in your browser"
          accessibilityRole="link"
          onPress={() => void Linking.openURL(officialUrl)}
          style={styles.officialLink}>
          <Text style={styles.officialLinkTitle}>Open the official {content.eyebrow.toLowerCase()}</Text>
          <Text style={styles.officialLinkText}>
            The counsel-approved web document controls if this plain-language summary differs.
          </Text>
        </Pressable>
      ) : null}
      {content.sections.map((section) => (
        <InfoSection icon={section.icon} key={section.title} title={section.title}>
          {section.body}
        </InfoSection>
      ))}
    </InfoScreen>
  );
}

const styles = StyleSheet.create({
  officialLink: {
    backgroundColor: palette.accentDeep,
    borderRadius: radii.lg,
    gap: spacing.xs,
    minHeight: 64,
    padding: spacing.lg,
  },
  officialLinkTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  officialLinkText: {
    color: '#DCEBE7',
    fontSize: 12,
    lineHeight: 18,
  },
});
