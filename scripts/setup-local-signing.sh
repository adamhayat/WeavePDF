#!/usr/bin/env bash
# Sets up a self-signed code-signing identity called "WeavePDF Local" in your
# login keychain. After running this once, all future `npm run package` builds
# sign with this STABLE identity — so the macOS Keychain stops prompting you
# to re-allow access to the safeStorage signature key after every rebuild.
#
# Why ad-hoc signing prompts every rebuild:
#   Ad-hoc (`codesign --sign -`) produces a unique CDHash per binary. macOS
#   Keychain ACLs pin to that exact hash, so the next rebuild's hash isn't on
#   the allowlist → Keychain prompts.
#
# How a stable identity fixes it:
#   With a real signing identity, the binary's "designated requirement"
#   includes "signed by this specific key" rather than the hash. The Keychain
#   ACL accepts any binary that satisfies the requirement, so future builds
#   with the same key are silently allowed.
#
# Idempotent — safe to re-run. Detects an existing identity and exits early.
#
# Usage: bash scripts/setup-local-signing.sh

set -euo pipefail

CERT_NAME="WeavePDF Local"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [[ ! -e "$KEYCHAIN" ]]; then
  echo "✗ Login keychain not found at $KEYCHAIN" >&2
  exit 1
fi

# Already set up?
# `find-identity -p codesigning` (without -v) returns identities regardless of
# trust state. Self-signed certs report CSSMERR_TP_NOT_TRUSTED but `codesign`
# itself accepts them — the trust check is only enforced by the strict -v
# filter, which is meant for Apple-CA-anchored identities (Developer ID).
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# V1.0027: even if the cert exists, we may still need the trust step. Skip
# generation but fall through to trust + final-check.
SKIP_CERT_GEN=0
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$CERT_NAME\""; then
  echo "✓ '$CERT_NAME' identity already exists. Checking trust state..."
  SKIP_CERT_GEN=1
  # Export the existing cert so the trust step has something to operate on.
  security find-certificate -c "$CERT_NAME" -p > "$TMPDIR/cert.pem"
fi

if [[ "$SKIP_CERT_GEN" -eq 1 ]]; then
  # Skip generation, jump to trust step.
  TRUST_ONLY=1
else
  TRUST_ONLY=0
fi

if [[ "$TRUST_ONLY" -eq 0 ]]; then

echo "Generating self-signed certificate '$CERT_NAME' (10-year validity)..."

# OpenSSL config that includes the codeSigning extended-key-usage flag —
# without this, the cert exists but codesign refuses to use it.
cat > "$TMPDIR/openssl.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_codesign

[dn]
CN = $CERT_NAME

[v3_codesign]
basicConstraints = CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

# Generate keypair + self-signed cert
openssl req -x509 \
  -newkey rsa:2048 \
  -nodes \
  -keyout "$TMPDIR/key.pem" \
  -out "$TMPDIR/cert.pem" \
  -days 3650 \
  -config "$TMPDIR/openssl.cnf" \
  > /dev/null 2>&1

# Bundle into PKCS#12 for keychain import. The `-legacy` flag forces the older
# RC2/3DES ciphers — modern OpenSSL 3.x defaults to AES-256 PBKDF2 which
# macOS's Security Framework can't decode (`security import` fails with
# "MAC verification failed" otherwise).
openssl pkcs12 -export -legacy \
  -out "$TMPDIR/cert.p12" \
  -inkey "$TMPDIR/key.pem" \
  -in "$TMPDIR/cert.pem" \
  -passout pass:weavepdf \
  > /dev/null 2>&1

echo "Importing into login keychain (you may see one Mac password prompt)..."

# Import the .p12. -A flag allows any application to access the key without
# further prompts; the alternative -T flag whitelists specific binaries.
# -A is more permissive but avoids surprise prompts in the rare case a
# different tool (e.g. xcodebuild) tries to use the cert.
if ! security import "$TMPDIR/cert.p12" \
       -k "$KEYCHAIN" \
       -P weavepdf \
       -A 2>"$TMPDIR/import.err" ; then
  echo "✗ security import failed:" >&2
  cat "$TMPDIR/import.err" >&2
  exit 1
fi

# set-key-partition-list updates the post-Sierra ACL on the imported key so
# codesign can use it without prompting. Requires your Mac login password.
# We use `-k ""` first; if it fails, fall through with a hint.
if ! security set-key-partition-list \
       -S apple-tool:,apple:,codesign:,unsigned: \
       -s \
       -k "" \
       "$KEYCHAIN" > /dev/null 2>&1 ; then
  echo ""
  echo "  ℹ️  Codesign may prompt 'Always Allow' on the first build. Click it once."
  echo "     To skip that prompt entirely, run:"
  echo ""
  echo "     security set-key-partition-list -S apple-tool:,apple:,codesign:,unsigned: -s -k <your Mac password> \"$KEYCHAIN\""
  echo ""
fi

fi # end TRUST_ONLY=0 block

# V1.0027: trust the cert as a code-signing root in the user's login
# keychain. Without this, macOS's Keychain ACL system can't pin the
# `WeavePDF Safe Storage` item to the cert's designated requirement —
# it falls back to per-CDHash pinning, which means every rebuild's new
# CDHash misses the ACL and prompts the user for their Mac password +
# "Always Allow" all over again. Trusting the cert lets the ACL pin to
# the cert's leaf hash (stable across rebuilds with the same key) so
# the prompt happens ONCE for the whole project lifetime, not once per
# update.
#
# This step prompts for your Mac password ONCE (to authorize the trust
# change). After that, future `npm run package` / `npm run release`
# rebuilds are silent — and so is opening WeavePDF after each install.
if ! security verify-cert -c "$TMPDIR/cert.pem" -p codeSign > /dev/null 2>&1; then
  echo "Trusting '$CERT_NAME' as a code-signing root (one Mac password prompt)..."
  if ! security add-trusted-cert -p codeSign \
         -k "$KEYCHAIN" \
         "$TMPDIR/cert.pem" 2>"$TMPDIR/trust.err"; then
    echo ""
    echo "  ⚠️  Could not trust the cert automatically. Without trust, the"
    echo "     macOS Keychain will re-prompt on every WeavePDF update."
    echo ""
    echo "     To fix manually, run (it'll ask for your Mac password once):"
    echo ""
    echo "     security add-trusted-cert -p codeSign -k \"$KEYCHAIN\" /tmp/weavepdf-cert.pem"
    echo ""
    echo "  (Saved cert to /tmp/weavepdf-cert.pem for that command.)"
    cp "$TMPDIR/cert.pem" /tmp/weavepdf-cert.pem
  else
    echo "✓ Cert trusted as code-signing root."
  fi
else
  echo "✓ Cert already trusted as code-signing root."
fi

# Final check (no -v: self-signed certs are reported as not-trusted but codesign
# still accepts them; the -v filter is for strict Apple-CA-anchored identities).
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$CERT_NAME\""; then
  echo ""
  echo "✓ Identity '$CERT_NAME' is ready."
  echo ""
  echo "Next:"
  echo "  1. npm run package           # Forge auto-detects + uses this identity"
  echo "  2. Reinstall /Applications/WeavePDF.app from out/WeavePDF-darwin-arm64/"
  echo "  3. First launch: macOS will ask ONE LAST TIME to access 'WeavePDF Safe"
  echo "     Storage' in your keychain. Enter your Mac password, click Always"
  echo "     Allow. (The existing keychain item was created under the old ad-hoc"
  echo "     signature; this binds it to the new stable identity.)"
  echo "  4. From then on, future rebuilds are silent."
  echo ""
else
  echo "✗ Setup completed but identity not visible. Try restarting Keychain Access."
  exit 1
fi
