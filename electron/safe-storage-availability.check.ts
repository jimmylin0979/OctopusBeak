import assert from "node:assert/strict";
import { assertSafeStorageCanEncrypt, SAFE_STORAGE_UNAVAILABLE_MESSAGE } from "./safe-storage-availability.ts";

assert.throws(
  () => assertSafeStorageCanEncrypt({ isEncryptionAvailable: () => false }, "darwin"),
  { message: SAFE_STORAGE_UNAVAILABLE_MESSAGE },
);

assert.throws(
  () =>
    assertSafeStorageCanEncrypt(
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
      },
      "linux",
    ),
  (error: Error) => error.message.startsWith(SAFE_STORAGE_UNAVAILABLE_MESSAGE),
);

// A Linux machine without a keyring is told how to repair it, not just refused.
assert.throws(
  () =>
    assertSafeStorageCanEncrypt(
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
      },
      "linux",
    ),
  /gnome-keyring.*libsecret.*desktop session/su,
);

assert.doesNotThrow(() =>
  assertSafeStorageCanEncrypt(
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
    },
    "linux",
  ),
);

assert.doesNotThrow(() =>
  assertSafeStorageCanEncrypt(
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
    },
    "darwin",
  ),
);
