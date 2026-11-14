# Apt signing key (ADR 0141)

The maintainer creates this once, by hand, on a machine they trust. CI never creates it and never holds the primary key.

What exists afterwards:

| Piece | Where it lives | Secret? |
| --- | --- | --- |
| Primary key (certify only, never expires) | Offline backup only | Yes, the most important one |
| Active signing subkey (expires in 2 years) | The `release` environment, as `APT_SIGNING_SUBKEY` | Yes |
| Standby signing subkey (expires in 3 years) | Offline backup only | Yes |
| Public keyring (primary and both subkeys) | `packaging/deb/octopusbeak-archive-keyring.gpg` in the repo | No |
| Fingerprint of the active subkey | The `release` environment variable `APT_SIGNING_SUBKEY_FPR` | No |

Never paste a private key, a passphrase, or an exported `.asc` secret file into a chat, an issue, or a commit.

## 1. Create the keys

Keep `GNUPGHOME` short; gpg-agent's socket path has a length limit and fails with a timeout when it is too long.

```bash
export GNUPGHOME="$HOME/.ob-gnupg"
mkdir -m 700 "$GNUPGHOME"

# The user ID becomes public in the keyring. Use an address you are happy to publish,
# for example your GitHub noreply address. gpg asks for a passphrase: choose a long one.
gpg --quick-generate-key "OctopusBeak Release <ADDRESS>" ed25519 cert never

FPR=$(gpg --with-colons --list-keys | awk -F: '/^fpr:/{print $10; exit}')
gpg --quick-add-key "$FPR" ed25519 sign 2y     # active
gpg --quick-add-key "$FPR" ed25519 sign 3y     # standby

gpg --with-colons --list-keys | awk -F: '/^fpr:/{n++; print n": "$10}'
# 1 is the primary, 2 the active subkey, 3 the standby subkey.
ACTIVE=$(gpg --with-colons --list-keys | awk -F: '/^fpr:/{n++; if(n==2){print $10}}')
```

## 2. Back up before anything else

```bash
gpg --armor --export-secret-keys "$FPR" > ob-primary-secret.asc     # primary and both subkeys
cp "$GNUPGHOME"/openpgp-revocs.d/*.rev .                            # revocation certificate
```

Put both files on encrypted storage that stays offline, and store the passphrase in your password manager. Lose the primary key and the repository can never be rotated safely. Delete the `.asc` file from the working machine afterwards.

## 3. Export the public keyring into the repo

```bash
gpg --export "$FPR" > packaging/deb/octopusbeak-archive-keyring.gpg
git add packaging/deb/octopusbeak-archive-keyring.gpg
```

This file is public and safe to commit. It holds the primary key and both subkeys. It must be exported after both subkeys exist, because users trust only what this file held when they installed it.

## 4. Give CI the active subkey only

```bash
gpg --armor --export-secret-subkeys "${ACTIVE}!" > ob-active-subkey.asc
head -1 ob-active-subkey.asc            # -----BEGIN PGP PRIVATE KEY BLOCK-----

# Secrets on the 'release' environment, which only the approved release job can read.
gh secret set APT_SIGNING_SUBKEY --env release --repo jimmylin0979/OctopusBeak < ob-active-subkey.asc
gh secret set APT_SIGNING_PASSPHRASE --env release --repo jimmylin0979/OctopusBeak   # prompts; type the passphrase
gh variable set APT_SIGNING_SUBKEY_FPR --env release --repo jimmylin0979/OctopusBeak --body "$ACTIVE"

shred -u ob-active-subkey.asc 2>/dev/null || rm -f ob-active-subkey.asc
```

The exported file has no primary secret in it. Importing it on another machine shows `sec#` for the primary (the `#` means the secret is absent) and an `ssb` line for the subkey. The passphrase that unlocks it is the one you chose in step 1; it cannot unlock the primary key from CI because the primary secret is not there.

## 5. Check it

```bash
gpg --list-secret-keys --keyid-format long    # on your machine: sec, ssb, ssb
gpg --show-keys packaging/deb/octopusbeak-archive-keyring.gpg   # pub plus two sub lines
```

## Rotating or replacing the subkey

1. Move the standby to CI: repeat step 4 with the standby's fingerprint, then update `APT_SIGNING_SUBKEY_FPR`.
2. Add a new standby: `gpg --quick-add-key "$FPR" ed25519 sign 3y`, then repeat step 3. The next `.deb` carries the new keyring; until a person installs it, their machine does not know the new standby.
3. To revoke a leaked subkey, `gpg --edit-key "$FPR"`, `key N`, `revkey`, then repeat step 3. A machine learns the revocation only from the next `.deb` it installs.
4. Renew before an expiry: `gpg --quick-set-expire "$FPR" 2y "$SUBFPR"`, repeat step 3, and release.

A change of primary key cannot be delivered through apt, because the keyring that apt trusts would not hold it. It needs a manual keyring reinstall by every user.
