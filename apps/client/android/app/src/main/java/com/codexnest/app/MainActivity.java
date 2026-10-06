package com.codexnest.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    static final String EXTRA_THREAD_ID = "com.codexnest.app.THREAD_ID";
    private static final String CAPACITOR_PREFERENCES = "CapacitorStorage";
    private static final String PENDING_THREAD_KEY = BuildConfig.STORAGE_PREFIX + ".pendingThreadId";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SelfHostedNotificationsPlugin.class);
        storePendingThread(getIntent());
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            // An explicit color also clears Android 15's forced light navigation
            // appearance, which otherwise follows the native window background.
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            // The chat paints its own theme-colored protection behind the buttons.
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    // Insets and the saved web theme may become available after
                    // the initial activity resume and React mount.
                    notifySystemBarsReset();
                }
            });
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        notifySystemBarsReset();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Capacitor's SystemBars resets to the Android theme here. Reapply the
        // selected app theme after that reset, including when the themes differ.
        notifySystemBarsReset();
    }

    private void notifySystemBarsReset() {
        if (getBridge() != null) {
            getBridge().triggerWindowJSEvent("codexnest:system-bars-reset");
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        storePendingThread(intent);
        super.onNewIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        SelfHostedNotificationService.setAppVisible(true);
    }

    @Override
    public void onStop() {
        SelfHostedNotificationService.setAppVisible(false);
        super.onStop();
    }

    private void storePendingThread(Intent intent) {
        if (intent == null) return;
        String threadId = intent.getStringExtra(EXTRA_THREAD_ID);
        if (threadId == null || threadId.isBlank()) return;
        SharedPreferences preferences = getSharedPreferences(CAPACITOR_PREFERENCES, Context.MODE_PRIVATE);
        preferences.edit().putString(PENDING_THREAD_KEY, threadId).apply();
    }

    static void acknowledgePendingThread(Context context, String threadId) {
        SharedPreferences preferences = context.getSharedPreferences(
            CAPACITOR_PREFERENCES,
            Context.MODE_PRIVATE
        );
        String pending = preferences.getString(PENDING_THREAD_KEY, null);
        if (pending == null || !pending.equals(threadId)) return;
        preferences.edit().remove(PENDING_THREAD_KEY).apply();
    }
}
