# Dependency security exception: Metro image parsing

Last reviewed: 2026-08-08

After upgrading to the exact Expo SDK 57 patch set and applying all available
non-breaking audit fixes, `npm audit` reports 10 high-severity findings. They
collapse to Metro's transitive `image-size@1.2.1` dependency and two denial-of-
service advisories affecting its ICNS, JXL, and HEIF parsers. Metro declares
`image-size@^1.0.2`; the package registry currently offers no non-vulnerable
release in that supported range. npm's proposed automatic remedy is a breaking
downgrade to Expo 53/React Native 0.72 and is not an acceptable security fix.

This is an unresolved build-pipeline risk. It must not be presented as fixed or
ignored merely because the parser is not bundled as application business logic.

Until upstream Expo/Metro publishes a compatible fix:

- run release builds in an isolated, disposable CI worker with no production
  database credentials, signing-key export access, or unrelated repository
  secrets;
- do not build untrusted pull-request assets in a privileged or secret-bearing
  workflow;
- restrict repository image additions to reviewed PNG, JPEG, WebP, and approved
  vector sources; reject ICNS, JXL, and HEIF inputs before Metro starts;
- cap asset sizes and scan repository assets before release builds;
- keep dependency monitoring active for patched Metro or `image-size` releases;
- rerun `npm audit`, Expo compatibility checks, native builds, and the full
  release suite before removing this exception.

`npm run verify:build-assets` now enforces the repository-controlled portion of
this mitigation before Metro runs: only approved project asset types, bounded
file and raster sizes, valid PNG/font/manifest signatures, safe path segments,
and no symlinks. Its regression tests include the affected parser-risk
extensions. This narrows the attack surface but does not patch Metro's transitive
parser; the exception remains open.

`brace-expansion` was separately overridden to fixed version `5.0.9`; do not
roll that override back. Never run `npm audit fix --force` here: its current
proposal replaces the SDK with incompatible major versions.
