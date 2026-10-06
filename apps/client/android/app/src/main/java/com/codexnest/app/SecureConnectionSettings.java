package com.codexnest.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONTokener;

final class SecureConnectionSettings {

    static final class Value {
        final String baseUrl;
        final String token;

        Value(String baseUrl, String token) {
            this.baseUrl = baseUrl;
            this.token = token;
        }
    }

    private static final String CAPACITOR_PREFERENCES = "CapacitorStorage";
    private static final String SECURE_PREFERENCES = "WSSecureStorageSharedPreferences";
    private static final String URL_KEY = BuildConfig.STORAGE_PREFIX + ".serverUrl";
    private static final String TOKEN_ALIAS = "capacitor-storage_" + BuildConfig.STORAGE_PREFIX + ".token";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String DATA_IV_SEPARATOR = "\u0010";
    private static final int BASE64_FLAGS = Base64.NO_PADDING | Base64.NO_WRAP;

    private SecureConnectionSettings() {}

    static boolean isStored(Context context) {
        return context
                .getSharedPreferences(CAPACITOR_PREFERENCES, Context.MODE_PRIVATE)
                .contains(URL_KEY)
            && context
                .getSharedPreferences(SECURE_PREFERENCES, Context.MODE_PRIVATE)
                .contains(TOKEN_ALIAS);
    }

    static Value read(Context context) {
        try {
            SharedPreferences preferences = context.getSharedPreferences(
                CAPACITOR_PREFERENCES,
                Context.MODE_PRIVATE
            );
            String baseUrl = preferences.getString(URL_KEY, null);
            String serializedToken = decryptToken(context);
            if (baseUrl == null || serializedToken == null) return null;
            Object parsed = new JSONTokener(serializedToken).nextValue();
            if (!(parsed instanceof String)) return null;
            String token = (String) parsed;
            return token.isBlank() ? null : new Value(baseUrl, token);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String decryptToken(Context context) throws Exception {
        String ciphertext = context
            .getSharedPreferences(SECURE_PREFERENCES, Context.MODE_PRIVATE)
            .getString(TOKEN_ALIAS, null);
        if (ciphertext == null) return null;
        String[] parts = ciphertext.split(DATA_IV_SEPARATOR, -1);
        if (parts.length != 2) return null;

        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) keyStore.getEntry(
            TOKEN_ALIAS,
            null
        );
        if (entry == null) return null;

        SecretKey secretKey = entry.getSecretKey();
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        byte[] iv = Base64.decode(parts[1], BASE64_FLAGS);
        cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
        byte[] encrypted = Base64.decode(parts[0], BASE64_FLAGS);
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }
}
