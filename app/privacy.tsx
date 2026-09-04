import { InfoScreen, InfoSection } from '@/components/info-screen';

export default function PrivacyScreen() {
  return (
    <InfoScreen
      eyebrow="Privacy"
      summary="Spottr uses location for nearby discovery and never attaches precise searches to your profile."
      title="Location use, explained plainly.">
      <InfoSection icon="location-crosshairs" title="Foreground location only">
        Spottr asks for location only while the app is open. If you choose “Use my location,” precise coordinates are
        sent over an encrypted connection to calculate distance-ranked results. You can search by city or ZIP instead.
      </InfoSection>
      <InfoSection icon="route" title="Routes use a navigation provider">
        If you start in-app navigation, Spottr sends your current location, public destination, and travel mode to
        Mapbox for a route. Rerouting is off by default. If enabled, location may be resent after at least 100 m and 90
        seconds while navigation stays active. Turning it off stops route requests; the foreground marker continues.
        Routes are not attached to your profile, and live updates stop when the app leaves the foreground. You can use
        your device’s maps app instead.
      </InfoSection>
      <InfoSection icon="house-lock" title="Home kitchens stay approximate">
        When legally enabled, public results show a reviewed service area. Residential addresses and exact home
        coordinates never appear in public APIs, map pins, or notifications.
      </InfoSection>
      <InfoSection icon="database" title="What Spottr stores">
        Spottr does not write search coordinates to profiles or marketplace tables. Infrastructure providers may
        process request and security logs under the retention terms in the public privacy policy.
      </InfoSection>
      <InfoSection icon="sliders" title="You stay in control">
        Change location permission in device settings at any time. Saved places, notifications, exports, and account
        deletion remain available from your profile.
      </InfoSection>
    </InfoScreen>
  );
}
