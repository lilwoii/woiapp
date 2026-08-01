import { InfoScreen, InfoSection } from '@/components/info-screen';

export default function SafetyScreen() {
  return (
    <InfoScreen
      eyebrow="Trust & safety"
      summary="Spottr combines account controls, database enforcement, content checks, and reporting tools."
      title="Useful local information, responsibly kept.">
      <InfoSection icon="user-check" title="Account-backed reviews">
        Reviews require a signed-in account, pass an early prohibited-language check, and remain private until an
        authorized moderator approves them. Database rate limits and duplicate checks reduce review manipulation.
        Public photo uploads stay disabled until the media safety pipeline is operational.
      </InfoSection>
      <InfoSection icon="flag" title="Confidential reporting">
        Members can report a listing, review, owner response or update, and individual approved media with a reason and
        optional context. Reports enter a restricted moderation queue and are not shown publicly.
      </InfoSection>
      <InfoSection icon="ban" title="Blocking and enforcement">
        Reviews from blocked accounts are hidden from that member’s community experience. Suspended accounts lose write and business
        privileges at the database boundary, not only in the interface.
      </InfoSection>
      <InfoSection icon="scale-balanced" title="Human decisions">
        Automated checks can flag content, but permanent enforcement decisions require an authorized operator. Public
        launch also requires documented escalation, appeal, and urgent-safety procedures for each service region.
      </InfoSection>
    </InfoScreen>
  );
}
