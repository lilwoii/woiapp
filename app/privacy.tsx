import { InfoScreen, InfoSection } from '@/components/info-screen';

export default function PrivacyScreen() {
  return (
    <InfoScreen
      eyebrow="Privacy"
      summary="Spottr limits location use to nearby discovery and does not attach precise search coordinates to your profile."
      title="Location use, explained plainly.">
      <InfoSection icon="location-crosshairs" title="Foreground location only">
        Spottr asks for location only while the app is open. If you choose “Use my location,” precise coordinates are
        sent over an encrypted connection to calculate distance-ranked results. You can search by city or ZIP instead.
      </InfoSection>
      <InfoSection icon="route" title="Routes use a navigation provider">
        If you explicitly start in-app navigation, Spottr sends your precise current starting location, public destination,
        and travel mode to Mapbox to calculate one route. Automatic rerouting is off by default. If you turn it on,
        Spottr may send your updated precise current location again after at least 100 m of movement and 90 seconds while
        navigation remains active. Turning it off stops additional Mapbox route requests while the foreground live
        marker continues.
        Spottr does not attach routes to your profile and stops live updates when the app leaves the foreground. You
        can use your device’s maps app instead.
      </InfoSection>
      <InfoSection icon="house-lock" title="Home kitchens stay approximate">
        When legally enabled, public results show only a reviewed service area. Residential addresses and raw residence
        coordinates never appear in public APIs, map pins, or notifications.
      </InfoSection>
      <InfoSection icon="database" title="What Spottr stores">
        Spottr does not write customer search coordinates to profiles or marketplace tables. Infrastructure providers
        may process request and security logs under the production retention settings disclosed in the final public
        privacy policy.
      </InfoSection>
      <InfoSection icon="sliders" title="You stay in control">
        Location permission can be changed in device settings at any time. Saved places, notification preferences,
        exports, and account deletion are available from your profile.
      </InfoSection>
    </InfoScreen>
  );
}
