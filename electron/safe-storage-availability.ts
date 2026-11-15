export const SAFE_STORAGE_UNAVAILABLE_MESSAGE =
  "Electron safeStorage encryption is not available. Refusing to read or write automation credentials.";

/** Linux has no OS keychain by default; the Secret Service must be installed and running. */
export const LINUX_KEYRING_GUIDANCE =
  "On Linux, install gnome-keyring and libsecret, then sign in to a desktop session so the Secret Service is running.";

type SafeStorageAvailability = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
};

export function assertSafeStorageCanEncrypt(storage: SafeStorageAvailability, platform = process.platform) {
  const message =
    platform === "linux" ? `${SAFE_STORAGE_UNAVAILABLE_MESSAGE} ${LINUX_KEYRING_GUIDANCE}` : SAFE_STORAGE_UNAVAILABLE_MESSAGE;
  if (!storage.isEncryptionAvailable()) {
    throw new Error(message);
  }
  if (platform === "linux" && storage.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error(message);
  }
}
